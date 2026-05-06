require("dotenv").config();
const express      = require("express");
const http         = require("http");
const WebSocket    = require("ws");
const axios        = require("axios");
const { spawn }    = require("child_process");
const { Readable } = require("stream");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 10000;

// ---------------------------------------------------------------------------
// CRITICAL ARCHITECTURE NOTE (learned from live logs):
//
// The problem: Exotel closes the WebSocket (code=1006) BEFORE our TTS reply
// finishes — or even starts. This happens because:
//
//   1. Caller speaks and goes silent
//   2. Exotel fires `stop` event immediately
//   3. Our code then does: STT (~2s) + AI (~1s) + TTS fetch (~2s) = ~5s
//   4. Exotel has already closed the WebSocket by then
//
// THE FIX:
//   - Detect end-of-speech via SILENCE TIMER (300ms), NOT the stop event
//   - Start STT+AI+TTS pipeline immediately when silence is detected
//   - The stop event is just a safety fallback flush — not the trigger
//   - 300ms silence < Exotel's hangup timeout, so we reply while call is live
//
// BARGE-IN:
//   - Caller speaks while bot is talking → buffer in bargeinChunks
//   - After TTS ends, drain bargeinChunks immediately
// ---------------------------------------------------------------------------

const PCM_SAMPLE_RATE      = 8000;
const PCM_BYTES_PER_SAMPLE = 2;
const FRAME_MS             = 20;
const FRAME_BYTES          = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * FRAME_MS / 1000; // 320B

// KEY TUNING: 300ms silence = end of speech. Must be shorter than Exotel's
// own hangup timer. Tune down if calls still close before reply. Min ~200ms.
const SILENCE_TIMEOUT_MS    = parseInt(process.env.SILENCE_TIMEOUT || "300", 10);
const SILENCE_ENERGY_THRESH = parseInt(process.env.ENERGY_THRESH   || "20",  10);
const SPEECH_ENERGY_THRESH  = parseInt(process.env.SPEECH_THRESH   || "50",  10);
const PCM_AMPLIFY           = parseFloat(process.env.PCM_AMPLIFY   || "40");

// Don't attempt STT on fewer than 2 packets (40ms) — noise bursts
const MIN_AUDIO_BYTES = 640;

const KEEPALIVE_INTERVAL_MS      = 200;
const KEEPALIVE_FRAMES_PER_BURST = 10;
const PCM_SILENCE_BYTE           = 0x00;

const COMPANY_CONTEXT =
  "You are a professional telecaller from Connect Ventures. " +
  "Keep every response to 1-2 short sentences. " +
  "Be warm, clear, and concise. Never repeat what the caller just said. " +
  "Do not use lists, bullet points, or special characters.";

const GREETING =
  "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const sessions = new Map();

// ---------------------------------------------------------------------------
// Env check
// ---------------------------------------------------------------------------
function checkEnv() {
  const required = ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY"];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) { console.error("Missing env vars:", missing.join(", ")); process.exit(1); }
  if (!process.env.CAM_API_KEY && !process.env.ELEVENLABS_API_KEY) {
    console.error("No TTS provider configured. Set CAM_API_KEY or ELEVENLABS_API_KEY.");
    process.exit(1);
  }
  const providers = [];
  if (process.env.CAM_API_KEY)        providers.push("CAMB.AI");
  if (process.env.ELEVENLABS_API_KEY) providers.push("ElevenLabs");
  console.log("Env OK | TTS providers:", providers.join(" -> "));
  console.log(`Silence timeout: ${SILENCE_TIMEOUT_MS}ms | VAD thresh: ${SILENCE_ENERGY_THRESH} | Speech thresh: ${SPEECH_ENERGY_THRESH}`);
  console.log("PCM amplify:", PCM_AMPLIFY);
}

// ---------------------------------------------------------------------------
// Send a 20ms PCM silence frame to Exotel
// ---------------------------------------------------------------------------
function sendPCMSilenceFrame(ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify({
      event: "media", stream_sid: streamSid,
      media: { payload: Buffer.alloc(FRAME_BYTES, PCM_SILENCE_BYTE).toString("base64") },
    }));
    return true;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Keepalive — keeps connection alive while we wait for TTS HTTP response
// ---------------------------------------------------------------------------
function startKeepalive(ws, streamSid) {
  let totalFrames = 0;
  const interval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { clearInterval(interval); return; }
    for (let i = 0; i < KEEPALIVE_FRAMES_PER_BURST; i++) { sendPCMSilenceFrame(ws, streamSid); totalFrames++; }
  }, KEEPALIVE_INTERVAL_MS);
  return () => {
    clearInterval(interval);
    console.log(`[KEEPALIVE] Stopped — ${totalFrames} frames (~${(totalFrames * FRAME_MS / 1000).toFixed(1)}s)`);
  };
}

// ---------------------------------------------------------------------------
// Stream ffmpeg stdout (PCM) → Exotel WebSocket
// ---------------------------------------------------------------------------
function streamPCMFromFFmpeg(ffProc, ws, streamSid, stopKeepalive) {
  return new Promise(resolve => {
    let remainder = Buffer.alloc(0);
    let sent      = 0;
    let kaStopped = false;
    const stopKA  = () => { if (!kaStopped && stopKeepalive) { stopKeepalive(); kaStopped = true; } };

    ffProc.stdout.on("data", chunk => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      stopKA();
      const buf = Buffer.concat([remainder, chunk]);
      let offset = 0;
      while (offset + FRAME_BYTES <= buf.length) {
        try {
          ws.send(JSON.stringify({
            event: "media", stream_sid: streamSid,
            media: { payload: buf.slice(offset, offset + FRAME_BYTES).toString("base64") },
          }));
          sent++;
        } catch (e) { console.warn("[STREAM] send error:", e.message); break; }
        offset += FRAME_BYTES;
      }
      remainder = buf.slice(offset);
    });

    ffProc.stdout.on("end", () => {
      stopKA();
      // Flush remaining bytes padded to frame boundary
      if (remainder.length > 0 && ws?.readyState === WebSocket.OPEN) {
        const pad = Buffer.concat([remainder, Buffer.alloc(FRAME_BYTES - (remainder.length % FRAME_BYTES), PCM_SILENCE_BYTE)]);
        try {
          ws.send(JSON.stringify({ event: "media", stream_sid: streamSid, media: { payload: pad.toString("base64") } }));
          sent++;
        } catch (_) {}
      }
      // Send mark so Exotel knows playback is done
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: "tts_done" } })); } catch (_) {}
      }
      const durSec = (sent * FRAME_BYTES) / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE);
      console.log(`[STREAM] ${sent} frames / ~${durSec.toFixed(1)}s audio sent`);
      resolve();
    });

    ffProc.stderr.on("data", d => { const m = d.toString().trim(); if (m) console.warn("[FFMPEG]", m); });
    ffProc.on("error", err => { stopKA(); console.error("[FFMPEG] spawn error:", err.message); resolve(); });
  });
}

// ---------------------------------------------------------------------------
// Convert audio buffer to s16le 8kHz mono PCM via ffmpeg, stream to Exotel
// ---------------------------------------------------------------------------
function convertAndStream(audioBuf, ws, streamSid, fmt, stopKeepalive) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", fmt, "-i", "pipe:0",
      "-ar", String(PCM_SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1",
    ]);
    Readable.from(audioBuf).pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    streamPCMFromFFmpeg(ff, ws, streamSid, stopKeepalive).then(resolve).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// TTS: CAMB.AI
// ---------------------------------------------------------------------------
async function streamTTSbyCamb(text, ws, streamSid, stopKeepalive) {
  if (!process.env.CAM_API_KEY) throw new Error("CAM_API_KEY not set");
  const voiceId = parseInt(process.env.CAMB_VOICE_ID || "147320", 10);
  console.log("[TTS/CAMB] Requesting:", text.slice(0, 70));
  const res = await axios.post(
    "https://client.camb.ai/apis/tts-stream",
    { text, language: "en-in", voice_id: voiceId, speech_model: "mars-flash", voice_settings: { speaking_rate: 1.05 } },
    { headers: { "x-api-key": process.env.CAM_API_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 8000 }
  );
  const buf = Buffer.from(res.data);
  console.log(`[TTS/CAMB] ${buf.length}B received`);
  if (buf.length < 100) throw new Error(`Audio too small: ${buf.length}B`);
  const fmt = buf.slice(0, 4).toString("ascii") === "RIFF" ? "wav" : "mp3";
  await convertAndStream(buf, ws, streamSid, fmt, stopKeepalive);
}

// ---------------------------------------------------------------------------
// TTS: ElevenLabs fallback
// ---------------------------------------------------------------------------
async function streamTTSbyElevenLabs(text, ws, streamSid, stopKeepalive) {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY not set");
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log("[TTS/EL] Requesting:", text.slice(0, 70));
  const res = await axios({
    method: "post",
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    data: { text, model_id: "eleven_turbo_v2", output_format: "mp3_44100_128", voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 } },
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    responseType: "arraybuffer",
    timeout: 12000,
  });
  const buf = Buffer.from(res.data);
  console.log(`[TTS/EL] ${buf.length}B received`);
  await convertAndStream(buf, ws, streamSid, "mp3", stopKeepalive);
}

// ---------------------------------------------------------------------------
// VAD helpers
// ---------------------------------------------------------------------------
function pcmEnergy(buf) {
  if (!buf || buf.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) sum += Math.abs(buf.readInt16LE(i));
  return sum / (buf.length / 2);
}

function amplifyPCM(buf, gain) {
  if (!gain || gain === 1) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    let s = Math.round(buf.readInt16LE(i) * gain);
    if (s >  32767) s =  32767;
    if (s < -32768) s = -32768;
    out.writeInt16LE(s, i);
  }
  return out;
}

function trimSpeechPCM(buf, thresh) {
  const frames = [];
  for (let i = 0; i + FRAME_BYTES <= buf.length; i += FRAME_BYTES) frames.push(buf.slice(i, i + FRAME_BYTES));
  let first = -1, last = -1;
  for (let f = 0; f < frames.length; f++) {
    if (pcmEnergy(frames[f]) >= thresh) { if (first === -1) first = f; last = f; }
  }
  if (first === -1) return buf;
  first = Math.max(0, first - 5);
  last  = Math.min(frames.length - 1, last + 5);
  const out = Buffer.concat(frames.slice(first, last + 1));
  console.log(`[TRIM] ${frames.length} → ${last - first + 1} frames`);
  return out;
}

// ---------------------------------------------------------------------------
// STT: Deepgram nova-2
// ---------------------------------------------------------------------------
async function speechToText(rawBuf) {
  const trimmed   = trimSpeechPCM(rawBuf, SILENCE_ENERGY_THRESH);
  const amplified = amplifyPCM(trimmed, PCM_AMPLIFY);
  console.log(`[STT] ${amplified.length}B | energy: raw=${pcmEnergy(trimmed).toFixed(0)} amplified=${pcmEnergy(amplified).toFixed(0)}`);
  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&encoding=linear16&sample_rate=8000&language=en-IN",
      amplified,
      {
        headers: { Authorization: "Token " + process.env.DEEPGRAM_API_KEY, "Content-Type": "audio/l16;rate=8000" },
        maxBodyLength: Infinity,
        timeout: 8000,
      }
    );
    const alt        = res.data?.results?.channels[0]?.alternatives[0];
    const transcript = alt?.transcript || "";
    const confidence = alt?.confidence  || 0;
    console.log(`[STT] "${transcript}" (conf=${confidence.toFixed(2)})`);
    return transcript;
  } catch (err) {
    console.error("[STT] Error:", err?.response?.status, err.message);
    return "";
  }
}

// ---------------------------------------------------------------------------
// LLM: Claude Haiku
// ---------------------------------------------------------------------------
async function getAIResponse(history, text) {
  history.push({ role: "user", content: text });
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 100, system: COMPANY_CONTEXT, messages: history },
      {
        headers: {
          "x-api-key":         process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 8000,
      }
    );
    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log(`[AI] "${reply}"`);
    return reply;
  } catch (err) {
    console.error("[AI] Error:", err?.response?.status, err?.response?.data || err.message);
    return "I'm sorry, could you say that again?";
  }
}

// ---------------------------------------------------------------------------
// Master TTS — always resets isSpeaking; drains barge-in after done
// ---------------------------------------------------------------------------
async function streamTTS(text, ws, streamSid, session) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[TTS] WebSocket not open — skipping");
    return;
  }
  if (!streamSid) {
    console.error("[TTS] No streamSid — skipping");
    return;
  }

  console.log("[TTS] Sending:", text.slice(0, 80));
  if (session) session.isSpeaking = true;

  const stopKeepalive = startKeepalive(ws, streamSid);
  let   succeeded     = false;

  // Try CAMB.AI first, ElevenLabs as fallback
  const providers = [
    { name: "CAMB.AI",    key: "CAM_API_KEY",        fn: () => streamTTSbyCamb(text, ws, streamSid, stopKeepalive) },
    { name: "ElevenLabs", key: "ELEVENLABS_API_KEY",  fn: () => streamTTSbyElevenLabs(text, ws, streamSid, stopKeepalive) },
  ];

  for (const p of providers) {
    if (!process.env[p.key]) continue;
    try {
      await p.fn();
      console.log("[TTS] Complete via", p.name);
      succeeded = true;
      break;
    } catch (err) {
      console.warn(`[TTS] ${p.name} failed:`, err.message.slice(0, 150));
    }
  }

  // ALWAYS reset state — if we don't, bot goes permanently deaf
  stopKeepalive();
  if (!succeeded) console.error("[TTS] All providers failed");
  if (session) {
    session.isSpeaking = false;

    // Drain any audio caller spoke while bot was talking (barge-in)
    if (session.bargeinChunks.length > 0 && !session.isProcessing) {
      const audio  = Buffer.concat(session.bargeinChunks);
      session.bargeinChunks = [];
      const energy = pcmEnergy(audio);
      console.log(`[BARGE-IN] ${audio.length}B energy=${energy.toFixed(0)}`);
      if (audio.length >= MIN_AUDIO_BYTES && energy >= SILENCE_ENERGY_THRESH) {
        processUtterance(audio, session, ws).catch(e => console.error("[BARGE-IN] error:", e.message));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Core pipeline: STT → AI → TTS
// ---------------------------------------------------------------------------
async function processUtterance(audio, session, ws) {
  if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) {
    console.warn("[UTT] WebSocket already closed — dropping utterance");
    return;
  }
  session.isProcessing = true;
  const startMs = Date.now();
  console.log(`[UTT] Start — ${audio.length}B audio`);

  try {
    const transcript = await speechToText(audio);

    if (!transcript || transcript.trim().length <= 2) {
      console.log("[UTT] No usable transcript — skipping");
      return;
    }

    // Check WS again before AI call
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) {
      console.warn("[UTT] WebSocket closed after STT — dropping");
      return;
    }

    const reply = await getAIResponse(session.history, transcript);

    // Check WS again before TTS
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) {
      console.warn("[UTT] WebSocket closed after AI — dropping TTS");
      return;
    }

    console.log(`[UTT] Pipeline so far: ${Date.now() - startMs}ms (STT+AI done, starting TTS)`);
    await streamTTS(reply, ws, session.streamSid, session);
    console.log(`[UTT] Total pipeline: ${Date.now() - startMs}ms`);

  } catch (err) {
    console.error("[UTT] Pipeline error:", err.message);
  } finally {
    session.isProcessing = false;

    // Drain any audio buffered while we were processing
    if (session.pendingChunks.length > 0) {
      const pending = Buffer.concat(session.pendingChunks);
      session.pendingChunks = [];
      const energy = pcmEnergy(pending);
      console.log(`[UTT] Draining pending: ${pending.length}B energy=${energy.toFixed(0)}`);
      if (pending.length >= MIN_AUDIO_BYTES && energy >= SILENCE_ENERGY_THRESH) {
        await processUtterance(pending, session, ws);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------
wss.on("connection", (ws, req) => {
  const callId   = Math.random().toString(36).substring(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] New call | callId=${callId} | IP=${clientIP}`);

  const session = {
    callId,
    history:          [],
    streamSid:        null,
    audioChunks:      [],   // caller audio accumulating toward next flush
    pendingChunks:    [],   // audio received while isProcessing=true
    bargeinChunks:    [],   // audio received while isSpeaking=true
    isProcessing:     false,
    isSpeaking:       false,
    greetingSent:     false,
    silenceTimer:     null,
    wsOpen:           true,
    mediaPacketCount: 0,
    mediaByteCount:   0,
    lastSpeechAt:     null,
  };
  sessions.set(callId, session);

  // ── Flush audio → STT pipeline ─────────────────────────────────────────
  // Called by silence timer (primary) and stop event (safety fallback only).
  // The silence timer is the REAL trigger. Stop-event is just insurance.
  async function flushAudio(trigger) {
    clearTimeout(session.silenceTimer);

    if (session.isProcessing) {
      console.log(`[VAD] flush skipped — already processing (trigger=${trigger})`);
      return;
    }
    if (session.audioChunks.length === 0) {
      console.log(`[VAD] flush — no audio (trigger=${trigger})`);
      return;
    }

    const audio = Buffer.concat(session.audioChunks);
    session.audioChunks = [];

    if (audio.length < MIN_AUDIO_BYTES) {
      console.log(`[VAD] flush — too short ${audio.length}B (trigger=${trigger})`);
      return;
    }

    const energy = pcmEnergy(audio);
    console.log(`[VAD] flush trigger=${trigger} audio=${audio.length}B energy=${energy.toFixed(0)} thresh=${SILENCE_ENERGY_THRESH}`);

    if (energy < SILENCE_ENERGY_THRESH) {
      console.log("[VAD] Silence — skipping STT");
      return;
    }

    console.log(`[VAD] Speech detected via ${trigger} — starting pipeline`);
    await processUtterance(audio, session, ws);
  }

  // ── Send greeting once streamSid is known ─────────────────────────────
  function maybeGreet() {
    if (session.greetingSent || !session.streamSid) return;
    session.greetingSent = true;
    session.history.push({ role: "assistant", content: GREETING });
    console.log("[GREET] Sending greeting...");
    streamTTS(GREETING, ws, session.streamSid, session).catch(e => {
      console.error("[GREET] TTS error:", e.message);
      if (session) session.isSpeaking = false;
    });
  }

  // ── Message handler ───────────────────────────────────────────────────
  ws.on("message", async rawMsg => {
    let data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    // ── connected ────────────────────────────────────────────────────────
    if (data.event === "connected") {
      console.log(`[WS] connected | ${callId}`);
    }

    // ── start ────────────────────────────────────────────────────────────
    if (data.event === "start") {
      const sid =
        data.stream_sid        ||
        data.streamSid         ||
        data.start?.stream_sid ||
        data.start?.streamSid  ||
        null;
      if (sid && !session.streamSid) session.streamSid = sid;
      console.log(`[WS] start | streamSid=${session.streamSid}`);
      console.log("[WS] start payload:", JSON.stringify(data).slice(0, 400));
      maybeGreet();
    }

    // ── media ─────────────────────────────────────────────────────────────
    if (data.event === "media") {
      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.mediaPacketCount++;
      session.mediaByteCount += rawBytes.length;

      // Some Exotel setups put streamSid only in media packets
      if (!session.streamSid && data.stream_sid) {
        session.streamSid = data.stream_sid;
        console.log(`[WS] streamSid from media: ${session.streamSid}`);
        maybeGreet();
      }

      // Log first 10 + every 200th
      if (session.mediaPacketCount <= 10 || session.mediaPacketCount % 200 === 0) {
        console.log(
          `[MEDIA] pkt#${session.mediaPacketCount} ${rawBytes.length}B` +
          ` hex=[${rawBytes.slice(0, 4).toString("hex")}]` +
          ` energy=${pcmEnergy(rawBytes).toFixed(0)}` +
          ` speaking=${session.isSpeaking} processing=${session.isProcessing}`
        );
      }

      // ── Routing of incoming audio ──────────────────────────────────────
      if (session.isSpeaking) {
        // Bot is talking — buffer for barge-in processing after TTS ends
        session.bargeinChunks.push(rawBytes);
        return;
      }

      if (session.isProcessing) {
        // STT/AI/TTS pipeline running — buffer until it finishes
        session.pendingChunks.push(rawBytes);
        return;
      }

      // Normal path — accumulate audio and (re)start silence timer
      session.audioChunks.push(rawBytes);

      const energy = pcmEnergy(rawBytes);
      if (energy >= SPEECH_ENERGY_THRESH) {
        session.lastSpeechAt = Date.now();
      }

      // ── Silence timer: PRIMARY end-of-speech trigger ───────────────────
      // 300ms after the last packet, fire the pipeline.
      // This fires WHILE THE CALL IS STILL ALIVE — which is the whole point.
      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(() => flushAudio("silence-timer"), SILENCE_TIMEOUT_MS);
    }

    // ── stop ──────────────────────────────────────────────────────────────
    // Safety net: if silence timer already fired and ran the pipeline,
    // this will find no chunks and do nothing. If somehow it didn't fire,
    // this catches it. Either way, no harm done.
    if (data.event === "stop") {
      clearTimeout(session.silenceTimer);
      console.log(
        `[WS] stop | ${callId}` +
        ` | pkts=${session.mediaPacketCount}` +
        ` | bytes=${session.mediaByteCount}`
      );
      if (session.mediaPacketCount === 0) {
        console.warn("[WS] WARNING: zero media packets — check Exotel applet config");
      }
      // Don't await — if WS closes immediately after, we still want to try
      flushAudio("stop-event").catch(e => console.error("[STOP] flushAudio error:", e.message));
    }

    // ── mark ──────────────────────────────────────────────────────────────
    if (data.event === "mark") {
      console.log("[WS] mark:", data.mark?.name || data.mark);
    }
  });

  ws.on("close", code => {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log(`[WS] closed | ${callId} | code=${code} | pkts=${session.mediaPacketCount}`);
    sessions.delete(callId);
  });

  ws.on("error", err => {
    session.wsOpen = false;
    console.error(`[WS] error | ${callId}:`, err.message);
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  const tts = [];
  if (process.env.CAM_API_KEY)        tts.push("CAMB.AI");
  if (process.env.ELEVENLABS_API_KEY) tts.push("ElevenLabs");
  res.json({
    status:           "ok",
    protocol:         "Exotel Voicebot s16le PCM",
    sessions:         sessions.size,
    uptime:           Math.floor(process.uptime()),
    tts,
    silence_timeout:  SILENCE_TIMEOUT_MS,
    energy_threshold: SILENCE_ENERGY_THRESH,
    speech_threshold: SPEECH_ENERGY_THRESH,
    pcm_amplify:      PCM_AMPLIFY,
  });
});

checkEnv();
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
