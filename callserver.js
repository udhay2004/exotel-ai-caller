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
// PROTOCOL: Exotel Voicebot — s16le PCM 8kHz mono, base64-encoded
//
// KEY LEARNINGS FROM LIVE CALL LOGS:
//   - Exotel audio amplitude ~+/-8 (background ~energy 9, speech ~energy 170)
//   - Caller speaks DURING the greeting → old code discarded it (isSpeaking=true)
//   - Exotel sends `stop` very fast after caller finishes → reply TTS arrives
//     after WebSocket is already closed → caller hears nothing
//
// FIXES:
//   1. BARGE-IN: Buffer audio even while bot is speaking. When caller talks
//      over the bot, we capture it and process it when TTS ends.
//   2. No artificial greeting delay — fire TTS as soon as streamSid is known.
//   3. CAMB.AI timeout reduced to 8s so ElevenLabs fallback kicks in faster.
//   4. processUtterance() moved to module scope so barge-in can call it.
// ---------------------------------------------------------------------------

const PCM_SAMPLE_RATE      = 8000;
const PCM_BYTES_PER_SAMPLE = 2;
const FRAME_MS             = 20;
const FRAME_BYTES          = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * FRAME_MS / 1000; // 320B

const SILENCE_ENERGY_THRESH = parseInt(process.env.ENERGY_THRESH   || "20",  10);
const SPEECH_ENERGY_THRESH  = parseInt(process.env.SPEECH_THRESH   || "50",  10);
const PCM_AMPLIFY           = parseFloat(process.env.PCM_AMPLIFY   || "40");
const SILENCE_TIMEOUT_MS    = parseInt(process.env.SILENCE_TIMEOUT || "500", 10);
const MIN_AUDIO_BYTES       = 3200;

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
  console.log("Env OK | TTS:", providers.join(" -> "));
  console.log(`VAD silence thresh: ${SILENCE_ENERGY_THRESH} | speech thresh: ${SPEECH_ENERGY_THRESH}`);
  console.log("PCM amplify gain:", PCM_AMPLIFY);
}

// ---------------------------------------------------------------------------
// Send a 20ms PCM silence frame to Exotel
// ---------------------------------------------------------------------------
function sendPCMSilenceFrame(ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const frame = Buffer.alloc(FRAME_BYTES, PCM_SILENCE_BYTE);
  try {
    ws.send(JSON.stringify({ event: "media", stream_sid: streamSid, media: { payload: frame.toString("base64") } }));
    return true;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Keepalive — silence bursts while TTS is fetching over the network
// ---------------------------------------------------------------------------
function startKeepalive(ws, streamSid) {
  let totalFrames = 0;
  const interval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { clearInterval(interval); return; }
    for (let i = 0; i < KEEPALIVE_FRAMES_PER_BURST; i++) { sendPCMSilenceFrame(ws, streamSid); totalFrames++; }
  }, KEEPALIVE_INTERVAL_MS);
  return function stop() {
    clearInterval(interval);
    console.log(`[KEEPALIVE] Stopped — ${totalFrames} frames (~${(totalFrames * FRAME_MS / 1000).toFixed(1)}s)`);
  };
}

// ---------------------------------------------------------------------------
// Stream ffmpeg PCM stdout → Exotel WebSocket
// ---------------------------------------------------------------------------
function streamPCMFromFFmpeg(ffProcess, ws, streamSid, stopKeepalive) {
  return new Promise(resolve => {
    let remainder = Buffer.alloc(0);
    let sent      = 0;
    let kaStopped = false;
    const stopKA  = () => { if (!kaStopped && stopKeepalive) { stopKeepalive(); kaStopped = true; } };

    ffProcess.stdout.on("data", chunk => {
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
        } catch (e) { console.warn("[STREAM] send error:", e.message); return; }
        offset += FRAME_BYTES;
      }
      remainder = buf.slice(offset);
    });

    ffProcess.stdout.on("end", () => {
      stopKA();
      if (remainder.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        const padLen = FRAME_BYTES - (remainder.length % FRAME_BYTES);
        try {
          ws.send(JSON.stringify({
            event: "media", stream_sid: streamSid,
            media: { payload: Buffer.concat([remainder, Buffer.alloc(padLen, PCM_SILENCE_BYTE)]).toString("base64") },
          }));
          sent++;
        } catch (_) {}
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: "tts_done" } })); } catch (_) {}
      }
      console.log(`[STREAM] ${sent} frames / ~${((sent * FRAME_BYTES) / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE)).toFixed(1)}s sent`);
      resolve();
    });

    ffProcess.stderr.on("data", e => { const m = e.toString().trim(); if (m) console.warn("[FFMPEG]", m); });
    ffProcess.on("error", err => { stopKA(); console.error("[FFMPEG] spawn error:", err.message); resolve(); });
  });
}

// ---------------------------------------------------------------------------
// Convert audio buffer → s16le PCM 8kHz mono via ffmpeg
// ---------------------------------------------------------------------------
function convertAndStream(audioBuf, ws, streamSid, fmt, stopKeepalive) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", fmt, "-i", "pipe:0",
      "-ar", String(PCM_SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1",
    ]);
    const sendP = streamPCMFromFFmpeg(ff, ws, streamSid, stopKeepalive);
    Readable.from(audioBuf).pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    sendP.then(resolve).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// TTS: CAMB.AI (8s timeout for faster fallback)
// ---------------------------------------------------------------------------
async function streamTTSbyCamb(text, ws, streamSid, stopKeepalive) {
  if (!process.env.CAM_API_KEY) throw new Error("CAM_API_KEY not set");
  const voiceId = parseInt(process.env.CAMB_VOICE_ID || "147320", 10);
  console.log("[TTS/CAMB] Fetching:", text.slice(0, 60));
  let res;
  try {
    res = await axios.post(
      "https://client.camb.ai/apis/tts-stream",
      { text, language: "en-in", voice_id: voiceId, speech_model: "mars-flash", voice_settings: { speaking_rate: 1.05 } },
      { headers: { "x-api-key": process.env.CAM_API_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 8000 }
    );
  } catch (err) {
    const body = err.response ? Buffer.from(err.response.data).toString("utf8").slice(0, 300) : err.message;
    console.error(`[TTS/CAMB] HTTP ${err.response?.status || "ERR"}: ${body}`);
    throw err;
  }
  const audioBuf = Buffer.from(res.data);
  console.log(`[TTS/CAMB] Received ${audioBuf.length}B`);
  if (audioBuf.length < 100) throw new Error(`Too small: ${audioBuf.length}B`);
  const magic = audioBuf.slice(0, 4).toString("ascii");
  const fmt   = magic === "RIFF" ? "wav" : "mp3";
  console.log("[TTS/CAMB] Format:", fmt);
  await convertAndStream(audioBuf, ws, streamSid, fmt, stopKeepalive);
}

// ---------------------------------------------------------------------------
// TTS: ElevenLabs fallback
// ---------------------------------------------------------------------------
async function streamTTSbyElevenLabs(text, ws, streamSid, stopKeepalive) {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY not set");
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log("[TTS/EL] Fetching:", text.slice(0, 60));
  let res;
  try {
    res = await axios({
      method: "post",
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      data: { text, model_id: "eleven_turbo_v2", output_format: "mp3_44100_128", voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 } },
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      responseType: "arraybuffer",
      timeout: 12000,
    });
  } catch (err) {
    const body = err.response ? Buffer.from(err.response.data).toString("utf8").slice(0, 300) : err.message;
    console.error(`[TTS/EL] HTTP ${err.response?.status || "ERR"}: ${body}`);
    throw err;
  }
  const audioBuf = Buffer.from(res.data);
  console.log(`[TTS/EL] Received ${audioBuf.length}B`);
  await convertAndStream(audioBuf, ws, streamSid, "mp3", stopKeepalive);
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

function trimSpeechPCM(buf, energyThresh) {
  const frames = [];
  for (let i = 0; i + FRAME_BYTES <= buf.length; i += FRAME_BYTES) frames.push(buf.slice(i, i + FRAME_BYTES));
  let first = -1, last = -1;
  for (let f = 0; f < frames.length; f++) {
    if (pcmEnergy(frames[f]) >= energyThresh) { if (first === -1) first = f; last = f; }
  }
  if (first === -1) return buf;
  first = Math.max(0, first - 10);
  last  = Math.min(frames.length - 1, last + 10);
  const trimmed = Buffer.concat(frames.slice(first, last + 1));
  console.log(`[TRIM] ${frames.length} frames -> ${last - first + 1} frames (kept ${first}-${last})`);
  return trimmed;
}

// ---------------------------------------------------------------------------
// STT: Deepgram nova-2
// ---------------------------------------------------------------------------
async function speechToText(rawBuffer) {
  const trimmed   = trimSpeechPCM(rawBuffer, SILENCE_ENERGY_THRESH);
  const amplified = amplifyPCM(trimmed, PCM_AMPLIFY);
  console.log(`[STT] ${amplified.length}B | energy raw=${pcmEnergy(trimmed).toFixed(0)} amplified=${pcmEnergy(amplified).toFixed(0)}`);
  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&encoding=linear16&sample_rate=8000&language=en-IN",
      amplified,
      {
        headers: { Authorization: "Token " + process.env.DEEPGRAM_API_KEY, "Content-Type": "audio/l16;rate=8000" },
        maxBodyLength: Infinity,
        timeout: 10000,
      }
    );
    const alt        = res.data?.results?.channels[0]?.alternatives[0];
    const transcript = alt?.transcript || "";
    const confidence = alt?.confidence || 0;
    console.log(`[STT] "${transcript}" (conf ${confidence.toFixed(2)})`);
    return transcript;
  } catch (err) {
    console.error("[STT]", err?.response?.status, err.message);
    return "";
  }
}

// ---------------------------------------------------------------------------
// LLM: Claude Haiku
// NOTE: No anthropic-beta header — invalid headers cause silent 400 rejections
// ---------------------------------------------------------------------------
async function getAIResponse(history, text) {
  history.push({ role: "user", content: text });
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 120, system: COMPANY_CONTEXT, messages: history },
      {
        headers: {
          "x-api-key":         process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 12000,
      }
    );
    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log(`[AI] "${reply}"`);
    return reply;
  } catch (err) {
    console.error("[AI]", err?.response?.status, err?.response?.data || err.message);
    return "I'm sorry, could you say that again?";
  }
}

// ---------------------------------------------------------------------------
// Process one complete utterance: STT → LLM → TTS
// Module-scope so it can be called from both flushAudio and barge-in handler
// ---------------------------------------------------------------------------
async function processUtterance(audio, session, ws) {
  if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) {
    console.warn("[UTT] WebSocket closed — cannot process utterance");
    return;
  }
  session.isProcessing = true;
  console.log(`[UTT] Processing ${audio.length}B`);
  try {
    const transcript = await speechToText(audio);
    if (transcript && transcript.trim().length > 2) {
      const reply = await getAIResponse(session.history, transcript);
      if (session.wsOpen && ws.readyState === WebSocket.OPEN) {
        await streamTTS(reply, ws, session.streamSid, session);
      } else {
        console.warn("[UTT] WebSocket closed before TTS could play");
      }
    } else {
      console.log("[UTT] Empty/short transcript — skipping");
    }
  } catch (err) {
    console.error("[UTT] Error:", err.message);
  } finally {
    session.isProcessing = false;
    console.log(`[UTT] Done. pending=${session.pendingChunks.length} pkts`);
    if (session.pendingChunks.length > 0) {
      const pending = Buffer.concat(session.pendingChunks);
      session.pendingChunks = [];
      const energy = pcmEnergy(pending);
      console.log(`[UTT] Draining ${pending.length}B energy=${energy.toFixed(0)}`);
      if (pending.length >= MIN_AUDIO_BYTES && energy >= SILENCE_ENERGY_THRESH) {
        await processUtterance(pending, session, ws);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Master TTS — ALWAYS resets isSpeaking; drains barge-in buffer after done
// ---------------------------------------------------------------------------
async function streamTTS(text, ws, streamSid, session) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!streamSid) { console.error("[TTS] No streamSid — skipping"); return; }
  console.log("[TTS] ->", text.slice(0, 80));
  if (session) session.isSpeaking = true;

  const stopKeepalive = startKeepalive(ws, streamSid);
  let succeeded = false;

  const providers = [
    { name: "CAMB.AI",    enabled: !!process.env.CAM_API_KEY,        fn: () => streamTTSbyCamb(text, ws, streamSid, stopKeepalive) },
    { name: "ElevenLabs", enabled: !!process.env.ELEVENLABS_API_KEY, fn: () => streamTTSbyElevenLabs(text, ws, streamSid, stopKeepalive) },
  ];

  for (const p of providers) {
    if (!p.enabled) continue;
    try {
      await p.fn();
      console.log("[TTS] Done via", p.name);
      succeeded = true;
      break;
    } catch (err) {
      console.warn(`[TTS] FAILED ${p.name}:`, err.message.slice(0, 200));
    }
  }

  // CRITICAL: always stop keepalive + reset isSpeaking regardless of outcome
  stopKeepalive();
  if (!succeeded) console.error("[TTS] All providers failed");

  if (session) {
    session.isSpeaking = false;

    // BARGE-IN: caller spoke while bot was talking — process it now
    if (session.bargeinChunks.length > 0 && !session.isProcessing) {
      const audio = Buffer.concat(session.bargeinChunks);
      session.bargeinChunks = [];
      const energy = pcmEnergy(audio);
      console.log(`[BARGE-IN] Flushing ${audio.length}B energy=${energy.toFixed(0)}`);
      if (audio.length >= MIN_AUDIO_BYTES && energy >= SILENCE_ENERGY_THRESH) {
        processUtterance(audio, session, ws).catch(e =>
          console.error("[BARGE-IN] processUtterance error:", e.message)
        );
      } else {
        console.log("[BARGE-IN] Barge-in audio too short or silent — skipped");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket handler — Exotel Voicebot protocol
// ---------------------------------------------------------------------------
wss.on("connection", (ws, req) => {
  const callId   = Math.random().toString(36).substring(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] New call | callId=${callId} | IP=${clientIP}`);

  const session = {
    callId,
    history:          [],
    streamSid:        null,
    audioChunks:      [],    // audio collected between flushes (normal path)
    pendingChunks:    [],    // audio received WHILE isProcessing
    bargeinChunks:    [],    // audio received WHILE isSpeaking (barge-in)
    isProcessing:     false,
    isSpeaking:       false,
    greetingSent:     false,
    silenceTimer:     null,
    speechDetected:   false,
    wsOpen:           true,
    mediaPacketCount: 0,
    mediaByteCount:   0,
    lastMediaAt:      null,
  };
  sessions.set(callId, session);

  // ── flushAudio ────────────────────────────────────────────────────────
  async function flushAudio(trigger) {
    clearTimeout(session.silenceTimer);
    session.speechDetected = false;

    if (session.isProcessing) {
      console.log(`[VAD] flushAudio skipped (processing) trigger=${trigger}`);
      return;
    }
    if (session.audioChunks.length === 0) {
      console.log(`[VAD] flushAudio — no chunks trigger=${trigger}`);
      return;
    }

    const audio = Buffer.concat(session.audioChunks);
    session.audioChunks = [];
    console.log(`[VAD] flushAudio trigger=${trigger} audio=${audio.length}B`);

    if (audio.length < MIN_AUDIO_BYTES) {
      console.log(`[VAD] Too short (${audio.length}B) — skipped`);
      return;
    }
    const energy = pcmEnergy(audio);
    console.log(`[VAD] energy=${energy.toFixed(0)} thresh=${SILENCE_ENERGY_THRESH}`);
    if (energy < SILENCE_ENERGY_THRESH) {
      console.log("[VAD] Silence — skipping");
      return;
    }
    console.log(`[VAD] Speech via ${trigger} — processing`);
    await processUtterance(audio, session, ws);
  }

  // ── Message handler ───────────────────────────────────────────────────
  ws.on("message", async rawMsg => {
    let data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    if (data.event === "connected") {
      console.log(`[WS] connected | ${callId}`);
    }

    if (data.event === "start") {
      const sid =
        data.stream_sid        ||
        data.streamSid         ||
        data.start?.stream_sid ||
        data.start?.streamSid  ||
        null;
      console.log(`[WS] start | streamSid=${sid}`);
      console.log("[WS] start payload:", JSON.stringify(data).slice(0, 500));
      if (sid) session.streamSid = sid;

      if (!session.greetingSent && session.streamSid) {
        session.greetingSent = true;
        session.history.push({ role: "assistant", content: GREETING });
        // No delay — fire greeting immediately
        streamTTS(GREETING, ws, session.streamSid, session).catch(e => {
          console.error("[GREETING] TTS error:", e.message);
          if (session) session.isSpeaking = false;
        });
      } else if (!session.streamSid) {
        console.warn("[WS] No streamSid in start — greeting deferred to first media packet");
      }
    }

    if (data.event === "media") {
      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.mediaPacketCount++;
      session.mediaByteCount += rawBytes.length;
      session.lastMediaAt = Date.now();

      // Capture late streamSid and fire greeting
      if (!session.streamSid && data.stream_sid) {
        session.streamSid = data.stream_sid;
        console.log(`[WS] streamSid captured from media: ${session.streamSid}`);
        if (!session.greetingSent) {
          session.greetingSent = true;
          session.history.push({ role: "assistant", content: GREETING });
          streamTTS(GREETING, ws, session.streamSid, session).catch(e => {
            console.error("[GREETING/late]", e.message);
            if (session) session.isSpeaking = false;
          });
        }
      }

      if (session.mediaPacketCount <= 10 || session.mediaPacketCount % 100 === 0) {
        console.log(
          `[MEDIA] pkt#${session.mediaPacketCount} ${rawBytes.length}B` +
          ` hex=[${rawBytes.slice(0, 4).toString("hex")}]` +
          ` energy=${pcmEnergy(rawBytes).toFixed(0)}` +
          ` speaking=${session.isSpeaking} processing=${session.isProcessing}`
        );
      }

      // BARGE-IN: buffer audio even while bot is speaking
      // (old code discarded it — caller's "Yes" was lost)
      if (session.isSpeaking) {
        session.bargeinChunks.push(rawBytes);
        return;
      }

      if (session.isProcessing) {
        session.pendingChunks.push(rawBytes);
        return;
      }

      session.audioChunks.push(rawBytes);

      // Log speech onset for diagnostics
      const energy = pcmEnergy(rawBytes);
      if (energy >= SPEECH_ENERGY_THRESH && !session.speechDetected) {
        session.speechDetected = true;
        console.log(`[VAD] Speech onset pkt#${session.mediaPacketCount} energy=${energy.toFixed(0)}`);
      }

      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(() => flushAudio("silence-timer"), SILENCE_TIMEOUT_MS);
    }

    if (data.event === "stop") {
      clearTimeout(session.silenceTimer);
      console.log(
        `[WS] stop | ${callId}` +
        ` | mediaPackets=${session.mediaPacketCount}` +
        ` | mediaBytes=${session.mediaByteCount}` +
        ` | lastMediaAt=${session.lastMediaAt ? new Date(session.lastMediaAt).toISOString() : "never"}`
      );
      if (session.mediaPacketCount === 0) {
        console.warn("[WS] WARNING: ZERO media packets — check Exotel applet config");
      }
      await flushAudio("stop-event");
    }

    if (data.event === "mark") {
      const markName = data.mark?.name || data.mark;
      console.log("[WS] mark:", markName);
    }
  });

  ws.on("close", code => {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log(
      `[WS] closed | ${callId}` +
      ` | code=${code}` +
      ` | mediaPackets=${session.mediaPacketCount}` +
      ` | mediaBytes=${session.mediaByteCount}`
    );
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
    status: "ok", protocol: "Exotel Voicebot s16le PCM",
    sessions: sessions.size, uptime: Math.floor(process.uptime()),
    tts,
    energy_threshold: SILENCE_ENERGY_THRESH,
    speech_threshold: SPEECH_ENERGY_THRESH,
    pcm_amplify: PCM_AMPLIFY,
  });
});

checkEnv();
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
