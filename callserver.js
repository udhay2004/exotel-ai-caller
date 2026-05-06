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
// ARCHITECTURE:
//
// Audio routing has 3 states:
//   isSpeaking=true  → bot is playing TTS  → buffer in bargeinChunks
//   isProcessing=true→ STT/AI running      → keep adding to audioChunks
//                                             (do NOT drain into separate calls)
//   idle             → accumulate audioChunks, silence timer runs
//
// The silence timer fires ONE flush after 700ms of quiet.
// We never fragment a caller's utterance into multiple STT calls.
// Minimum audio before STT: 8000 bytes = 500ms at 8kHz s16le.
// ---------------------------------------------------------------------------

const PCM_SAMPLE_RATE      = 8000;
const PCM_BYTES_PER_SAMPLE = 2;
const FRAME_MS             = 20;
const FRAME_BYTES          = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * FRAME_MS / 1000; // 320B

// 700ms silence = end of utterance. Long enough to catch natural speech pauses.
const SILENCE_TIMEOUT_MS    = parseInt(process.env.SILENCE_TIMEOUT || "700",  10);
const SILENCE_ENERGY_THRESH = parseInt(process.env.ENERGY_THRESH   || "20",   10);
const PCM_AMPLIFY           = parseFloat(process.env.PCM_AMPLIFY   || "40");

// Minimum audio to send to Deepgram: 500ms = 8000B at 8kHz s16le
// Deepgram cannot transcribe less than ~300ms reliably
const MIN_STT_BYTES = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * 500 / 1000; // 8000B

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
  const tts = [];
  if (process.env.CAM_API_KEY)        tts.push("CAMB.AI");
  if (process.env.ELEVENLABS_API_KEY) tts.push("ElevenLabs");
  console.log("Env OK | TTS:", tts.join(" -> "));
  console.log(`Silence timeout: ${SILENCE_TIMEOUT_MS}ms | VAD thresh: ${SILENCE_ENERGY_THRESH} | Min STT bytes: ${MIN_STT_BYTES}`);
  console.log("PCM amplify:", PCM_AMPLIFY);
}

// ---------------------------------------------------------------------------
// PCM silence frame
// ---------------------------------------------------------------------------
function sendSilenceFrame(ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({
      event: "media", stream_sid: streamSid,
      media: { payload: Buffer.alloc(FRAME_BYTES, PCM_SILENCE_BYTE).toString("base64") },
    }));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Keepalive during TTS fetch
// ---------------------------------------------------------------------------
function startKeepalive(ws, streamSid) {
  let total = 0;
  const iv = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { clearInterval(iv); return; }
    for (let i = 0; i < KEEPALIVE_FRAMES_PER_BURST; i++) { sendSilenceFrame(ws, streamSid); total++; }
  }, KEEPALIVE_INTERVAL_MS);
  return () => { clearInterval(iv); console.log(`[KA] stopped — ${total} frames`); };
}

// ---------------------------------------------------------------------------
// Stream ffmpeg PCM → Exotel
// ---------------------------------------------------------------------------
function streamPCMFromFFmpeg(ff, ws, streamSid, stopKA) {
  return new Promise(resolve => {
    let rem = Buffer.alloc(0), sent = 0, stopped = false;
    const doStopKA = () => { if (!stopped && stopKA) { stopKA(); stopped = true; } };

    ff.stdout.on("data", chunk => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      doStopKA();
      const buf = Buffer.concat([rem, chunk]);
      let off = 0;
      while (off + FRAME_BYTES <= buf.length) {
        try {
          ws.send(JSON.stringify({
            event: "media", stream_sid: streamSid,
            media: { payload: buf.slice(off, off + FRAME_BYTES).toString("base64") },
          }));
          sent++;
        } catch (e) { console.warn("[STREAM] send err:", e.message); break; }
        off += FRAME_BYTES;
      }
      rem = buf.slice(off);
    });

    ff.stdout.on("end", () => {
      doStopKA();
      if (rem.length > 0 && ws?.readyState === WebSocket.OPEN) {
        const pad = Buffer.concat([rem, Buffer.alloc(FRAME_BYTES - (rem.length % FRAME_BYTES), PCM_SILENCE_BYTE)]);
        try { ws.send(JSON.stringify({ event: "media", stream_sid: streamSid, media: { payload: pad.toString("base64") } })); sent++; } catch (_) {}
      }
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: "tts_done" } })); } catch (_) {}
      }
      console.log(`[STREAM] ${sent} frames / ~${((sent * FRAME_BYTES) / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE)).toFixed(1)}s sent`);
      resolve();
    });

    ff.stderr.on("data", d => { const m = d.toString().trim(); if (m) console.warn("[FF]", m); });
    ff.on("error", err => { doStopKA(); console.error("[FF] spawn:", err.message); resolve(); });
  });
}

function convertAndStream(buf, ws, streamSid, fmt, stopKA) {
  return new Promise((res, rej) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", fmt, "-i", "pipe:0", "-ar", String(PCM_SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1"]);
    Readable.from(buf).pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    streamPCMFromFFmpeg(ff, ws, streamSid, stopKA).then(res).catch(rej);
  });
}

// ---------------------------------------------------------------------------
// TTS providers
// ---------------------------------------------------------------------------
async function ttsViaCamb(text, ws, streamSid, stopKA) {
  if (!process.env.CAM_API_KEY) throw new Error("no CAM_API_KEY");
  console.log("[TTS/CAMB] ->", text.slice(0, 60));
  const res = await axios.post(
    "https://client.camb.ai/apis/tts-stream",
    { text, language: "en-in", voice_id: parseInt(process.env.CAMB_VOICE_ID || "147320", 10), speech_model: "mars-flash", voice_settings: { speaking_rate: 1.05 } },
    { headers: { "x-api-key": process.env.CAM_API_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 9000 }
  );
  const audio = Buffer.from(res.data);
  if (audio.length < 100) throw new Error(`CAMB audio too small: ${audio.length}B`);
  console.log(`[TTS/CAMB] ${audio.length}B`);
  const fmt = audio.slice(0, 4).toString("ascii") === "RIFF" ? "wav" : "mp3";
  await convertAndStream(audio, ws, streamSid, fmt, stopKA);
}

async function ttsViaElevenLabs(text, ws, streamSid, stopKA) {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error("no ELEVENLABS_API_KEY");
  const vid = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log("[TTS/EL] ->", text.slice(0, 60));
  const res = await axios({
    method: "post",
    url: `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`,
    data: { text, model_id: "eleven_turbo_v2", output_format: "mp3_44100_128", voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 } },
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    responseType: "arraybuffer", timeout: 12000,
  });
  const audio = Buffer.from(res.data);
  console.log(`[TTS/EL] ${audio.length}B`);
  await convertAndStream(audio, ws, streamSid, "mp3", stopKA);
}

async function streamTTS(text, ws, streamSid, session) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !streamSid) {
    console.warn("[TTS] skip — ws closed or no streamSid");
    return;
  }
  console.log("[TTS] ->", text.slice(0, 80));
  if (session) session.isSpeaking = true;

  const stopKA = startKeepalive(ws, streamSid);
  let ok = false;

  for (const [name, key, fn] of [
    ["CAMB.AI",    "CAM_API_KEY",       () => ttsViaCamb(text, ws, streamSid, stopKA)],
    ["ElevenLabs", "ELEVENLABS_API_KEY",() => ttsViaElevenLabs(text, ws, streamSid, stopKA)],
  ]) {
    if (!process.env[key]) continue;
    try { await fn(); ok = true; console.log("[TTS] done via", name); break; }
    catch (e) { console.warn(`[TTS] ${name} failed:`, e.message.slice(0, 120)); }
  }

  stopKA();
  if (!ok) console.error("[TTS] all providers failed");

  if (session) {
    session.isSpeaking = false;

    // Barge-in: caller spoke while bot was talking — process the full buffer now
    if (session.bargeinChunks.length > 0 && !session.isProcessing) {
      const audio = Buffer.concat(session.bargeinChunks);
      session.bargeinChunks = [];
      console.log(`[BARGE-IN] ${audio.length}B collected while bot was speaking`);
      if (audio.length >= MIN_STT_BYTES && pcmEnergy(audio) >= SILENCE_ENERGY_THRESH) {
        processUtterance(audio, session, ws).catch(e => console.error("[BARGE-IN]", e.message));
      } else {
        console.log("[BARGE-IN] too short or silent — discarded");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// VAD
// ---------------------------------------------------------------------------
function pcmEnergy(buf) {
  if (!buf || buf.length < 2) return 0;
  let s = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) s += Math.abs(buf.readInt16LE(i));
  return s / (buf.length / 2);
}

function amplifyPCM(buf, gain) {
  if (!gain || gain === 1) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    let v = Math.round(buf.readInt16LE(i) * gain);
    if (v >  32767) v =  32767;
    if (v < -32768) v = -32768;
    out.writeInt16LE(v, i);
  }
  return out;
}

function trimSpeechPCM(buf, thresh) {
  const frames = [];
  for (let i = 0; i + FRAME_BYTES <= buf.length; i += FRAME_BYTES) frames.push(buf.slice(i, i + FRAME_BYTES));
  let first = -1, last = -1;
  for (let f = 0; f < frames.length; f++) {
    if (pcmEnergy(frames[f]) >= thresh) { if (first < 0) first = f; last = f; }
  }
  if (first < 0) return buf;
  first = Math.max(0, first - 5);
  last  = Math.min(frames.length - 1, last + 5);
  const out = Buffer.concat(frames.slice(first, last + 1));
  console.log(`[TRIM] ${frames.length} → ${last - first + 1} frames`);
  return out;
}

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------
async function speechToText(raw) {
  const trimmed   = trimSpeechPCM(raw, SILENCE_ENERGY_THRESH);
  const amplified = amplifyPCM(trimmed, PCM_AMPLIFY);
  console.log(`[STT] sending ${amplified.length}B (${(amplified.length / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE)).toFixed(2)}s) energy=${pcmEnergy(trimmed).toFixed(0)}`);
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
    const alt  = res.data?.results?.channels[0]?.alternatives[0];
    const text = alt?.transcript || "";
    console.log(`[STT] "${text}" (conf=${(alt?.confidence || 0).toFixed(2)})`);
    return text;
  } catch (e) {
    console.error("[STT] error:", e?.response?.status, e.message);
    return "";
  }
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------
async function getAIResponse(history, text) {
  history.push({ role: "user", content: text });
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 100, system: COMPANY_CONTEXT, messages: history },
      {
        headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        timeout: 8000,
      }
    );
    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log(`[AI] "${reply}"`);
    return reply;
  } catch (e) {
    console.error("[AI] error:", e?.response?.status, e?.response?.data || e.message);
    return "I'm sorry, could you say that again?";
  }
}

// ---------------------------------------------------------------------------
// Core pipeline: one complete utterance → STT → AI → TTS
// ---------------------------------------------------------------------------
async function processUtterance(audio, session, ws) {
  if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) {
    console.warn("[UTT] ws closed — drop");
    return;
  }
  const t0 = Date.now();
  session.isProcessing = true;
  console.log(`[UTT] start — ${audio.length}B (${(audio.length / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE)).toFixed(2)}s audio)`);

  try {
    const transcript = await speechToText(audio);
    if (!transcript || transcript.trim().length < 2) {
      console.log("[UTT] empty transcript — skip");
      return;
    }
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) { console.warn("[UTT] ws closed after STT"); return; }
    const reply = await getAIResponse(session.history, transcript);
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) { console.warn("[UTT] ws closed after AI"); return; }
    console.log(`[UTT] STT+AI done in ${Date.now() - t0}ms — starting TTS`);
    await streamTTS(reply, ws, session.streamSid, session);
    console.log(`[UTT] total pipeline ${Date.now() - t0}ms`);
  } catch (e) {
    console.error("[UTT] error:", e.message);
  } finally {
    session.isProcessing = false;
    // If new audio arrived while we were processing, handle it
    // but DON'T drain into micro-chunks — wait for a full utterance
    if (session.pendingFlush) {
      session.pendingFlush = false;
      const pending = Buffer.concat(session.audioChunks);
      session.audioChunks = [];
      if (pending.length >= MIN_STT_BYTES && pcmEnergy(pending) >= SILENCE_ENERGY_THRESH) {
        console.log(`[UTT] draining deferred audio: ${pending.length}B`);
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
  console.log(`\n[WS] New call | ${callId} | ${clientIP}`);

  const session = {
    callId,
    history:          [],
    streamSid:        null,
    audioChunks:      [],    // ALL caller audio accumulates here until flush
    bargeinChunks:    [],    // audio while bot is speaking
    isProcessing:     false,
    isSpeaking:       false,
    pendingFlush:     false, // set when silence fires during processing
    greetingSent:     false,
    silenceTimer:     null,
    wsOpen:           true,
    mediaPacketCount: 0,
    mediaByteCount:   0,
  };
  sessions.set(callId, session);

  // ── Flush: collect everything, run ONE STT call ────────────────────────
  async function flushAudio(trigger) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;

    if (session.audioChunks.length === 0) {
      console.log(`[VAD] flush(${trigger}) — no audio`);
      return;
    }

    const audio = Buffer.concat(session.audioChunks);
    // Keep audioChunks empty so new packets accumulate fresh
    session.audioChunks = [];

    const energy = pcmEnergy(audio);
    console.log(`[VAD] flush(${trigger}) ${audio.length}B ${(audio.length/(PCM_SAMPLE_RATE*PCM_BYTES_PER_SAMPLE)).toFixed(2)}s energy=${energy.toFixed(0)}`);

    if (audio.length < MIN_STT_BYTES) {
      console.log(`[VAD] too short (${audio.length}B < ${MIN_STT_BYTES}B) — skip`);
      return;
    }
    if (energy < SILENCE_ENERGY_THRESH) {
      console.log("[VAD] below energy threshold — skip");
      return;
    }

    if (session.isProcessing) {
      // Pipeline already running — note that we need a follow-up flush
      console.log("[VAD] pipeline busy — marking pendingFlush");
      // Put audio back so processUtterance can drain it
      session.audioChunks = Array.from(audio); // will be concat'd in finally block
      session.pendingFlush = true;
      return;
    }

    await processUtterance(audio, session, ws);
  }

  function maybeGreet() {
    if (session.greetingSent || !session.streamSid) return;
    session.greetingSent = true;
    session.history.push({ role: "assistant", content: GREETING });
    console.log("[GREET] firing greeting TTS");
    streamTTS(GREETING, ws, session.streamSid, session).catch(e => {
      console.error("[GREET]", e.message);
      if (session) session.isSpeaking = false;
    });
  }

  ws.on("message", async rawMsg => {
    let data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    if (data.event === "connected") {
      console.log(`[WS] connected | ${callId}`);
    }

    if (data.event === "start") {
      const sid = data.stream_sid || data.streamSid || data.start?.stream_sid || data.start?.streamSid || null;
      if (sid) session.streamSid = sid;
      console.log(`[WS] start | streamSid=${session.streamSid}`);
      maybeGreet();
    }

    if (data.event === "media") {
      const raw = Buffer.from(data.media.payload, "base64");
      session.mediaPacketCount++;
      session.mediaByteCount += raw.length;

      // Late streamSid
      if (!session.streamSid && data.stream_sid) {
        session.streamSid = data.stream_sid;
        console.log(`[WS] streamSid from media: ${session.streamSid}`);
        maybeGreet();
      }

      if (session.mediaPacketCount <= 10 || session.mediaPacketCount % 200 === 0) {
        console.log(`[MEDIA] pkt#${session.mediaPacketCount} energy=${pcmEnergy(raw).toFixed(0)} speaking=${session.isSpeaking} processing=${session.isProcessing}`);
      }

      // Routing
      if (session.isSpeaking) {
        // Buffer for barge-in — process after TTS finishes
        session.bargeinChunks.push(raw);
        return;
      }

      // Always accumulate — whether processing or not
      // We collect audio continuously and only flush on silence
      session.audioChunks.push(raw);

      // Reset silence timer on every packet
      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(() => flushAudio("silence-timer"), SILENCE_TIMEOUT_MS);
    }

    if (data.event === "stop") {
      clearTimeout(session.silenceTimer);
      console.log(`[WS] stop | ${callId} | pkts=${session.mediaPacketCount}`);
      if (session.mediaPacketCount === 0) console.warn("[WS] WARNING: zero media packets");
      // Fire and forget — WS may close immediately after
      flushAudio("stop-event").catch(e => console.error("[STOP]", e.message));
    }

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

  ws.on("error", err => { session.wsOpen = false; console.error(`[WS] error | ${callId}:`, err.message); });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  const tts = [];
  if (process.env.CAM_API_KEY)        tts.push("CAMB.AI");
  if (process.env.ELEVENLABS_API_KEY) tts.push("ElevenLabs");
  res.json({
    status: "ok", sessions: sessions.size, uptime: Math.floor(process.uptime()),
    tts, silence_timeout: SILENCE_TIMEOUT_MS, energy_threshold: SILENCE_ENERGY_THRESH,
    min_stt_bytes: MIN_STT_BYTES, pcm_amplify: PCM_AMPLIFY,
  });
});

checkEnv();
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
