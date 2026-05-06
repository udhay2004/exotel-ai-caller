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
// ENCODING AUTO-DETECTION:
// We log the first packet's byte distribution to determine what Exotel
// actually sends. This has been the root cause of all STT failures.
// The session.encoding field is set on first packet and used for all STT calls.
//
// Supported: "mulaw" | "linear16" | "alaw"
// Deepgram param is set accordingly.
// ---------------------------------------------------------------------------

const PCM_SAMPLE_RATE      = 8000;
const PCM_BYTES_PER_SAMPLE = 2;
const FRAME_MS             = 20;
const FRAME_BYTES          = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * FRAME_MS / 1000; // 320B

const SILENCE_TIMEOUT_MS = parseInt(process.env.SILENCE_TIMEOUT || "800", 10);
const MIN_STT_BYTES      = 8000; // 1s worth at 8kHz (works for both mulaw and linear16)
const PCM_SILENCE_BYTE   = 0x00;

const KEEPALIVE_INTERVAL_MS      = 200;
const KEEPALIVE_FRAMES_PER_BURST = 10;

const COMPANY_CONTEXT =
  "You are a professional telecaller from Connect Ventures. " +
  "Keep every response to 1-2 short sentences. " +
  "Be warm, clear, and concise. Never repeat what the caller just said. " +
  "Do not use lists, bullet points, or special characters.";

const GREETING =
  "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const sessions = new Map();

// ---------------------------------------------------------------------------
// G.711 mulaw decode (for VAD energy only when encoding=mulaw)
// ---------------------------------------------------------------------------
const MULAW_DECODE_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const b = ~i & 0xFF;
    const sign = (b & 0x80) ? -1 : 1;
    const exp  = (b >> 4) & 0x07;
    const mant = b & 0x0F;
    t[i] = sign * (((mant << 1) + 33) << (exp + 1)) - sign * 33;
  }
  return t;
})();

// G.711 alaw decode
const ALAW_DECODE_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let a = i ^ 0x55;
    const sign = (a & 0x80) ? 1 : -1;
    a &= 0x7F;
    let linear;
    if (a < 16) { linear = (a << 1) + 1; }
    else {
      const exp  = (a >> 4) & 0x07;
      const mant = a & 0x0F;
      linear = ((mant << 1) + 33) << (exp - 1);
    }
    t[i] = sign * linear;
  }
  return t;
})();

function decodeAudio(buf, encoding) {
  if (encoding === "linear16") return buf; // already PCM, no-op
  const table = encoding === "alaw" ? ALAW_DECODE_TABLE : MULAW_DECODE_TABLE;
  const out = Buffer.allocUnsafe(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(table[buf[i]], i * 2);
  return out;
}

// ---------------------------------------------------------------------------
// Detect encoding from first packet byte distribution
// ---------------------------------------------------------------------------
function detectEncoding(buf) {
  const counts = new Array(256).fill(0);
  const sampleSize = Math.min(buf.length, 640);
  for (let i = 0; i < sampleSize; i++) counts[buf[i]]++;

  const ff  = counts[0xFF]; // mulaw silence
  const x7f = counts[0x7F]; // alt mulaw silence
  const d5  = counts[0xD5]; // alaw silence
  const x00 = counts[0x00]; // linear16 silence LSB
  const x80 = counts[0x80]; // linear16 silence MSB

  console.log(`[DETECT] Sample ${sampleSize}B | 0xFF:${ff} 0x7F:${x7f} 0xD5:${d5} 0x00:${x00} 0x80:${x80}`);
  console.log(`[DETECT] First 32 bytes: ${buf.slice(0, 32).toString("hex")}`);

  // Linear16 silence: lots of 0x00 bytes (both bytes of each zero sample)
  if (x00 > sampleSize * 0.3) {
    console.log("[DETECT] Encoding: LINEAR16 (many 0x00 bytes = s16le silence)");
    return "linear16";
  }
  // Alaw silence: 0xD5 is the alaw silence codeword
  if (d5 > sampleSize * 0.1) {
    console.log("[DETECT] Encoding: ALAW (PCMA)");
    return "alaw";
  }
  // Mulaw silence: 0xFF or 0x7F
  if (ff > sampleSize * 0.1 || x7f > sampleSize * 0.05) {
    console.log("[DETECT] Encoding: MULAW (PCMU)");
    return "mulaw";
  }
  // Default — most Exotel deployments use mulaw
  console.log("[DETECT] Encoding: MULAW (default — ambiguous sample)");
  return "mulaw";
}

// ---------------------------------------------------------------------------
// VAD — works on decoded linear16 PCM
// ---------------------------------------------------------------------------
function pcmEnergy(buf) {
  if (!buf || buf.length < 2) return 0;
  let s = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) s += Math.abs(buf.readInt16LE(i));
  return s / (buf.length >> 1);
}

// Energy threshold — set after encoding detected
// linear16 raw: silence=0-500, speech=1000+
// decoded mulaw/alaw: silence=0-400, speech=800+
function getEnergyThresh(encoding) {
  if (process.env.ENERGY_THRESH) return parseInt(process.env.ENERGY_THRESH, 10);
  return encoding === "linear16" ? 500 : 500;
}

// ---------------------------------------------------------------------------
// Env check
// ---------------------------------------------------------------------------
function checkEnv() {
  const required = ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY"];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) { console.error("Missing env vars:", missing.join(", ")); process.exit(1); }
  if (!process.env.ELEVENLABS_API_KEY && !process.env.CAM_API_KEY) {
    console.error("No TTS provider. Set ELEVENLABS_API_KEY or CAM_API_KEY."); process.exit(1);
  }
  const tts = [];
  if (process.env.ELEVENLABS_API_KEY) tts.push("ElevenLabs (streaming)");
  if (process.env.CAM_API_KEY)        tts.push("CAMB.AI");
  console.log("Env OK | TTS:", tts.join(" -> "));
  console.log(`Silence: ${SILENCE_TIMEOUT_MS}ms | Min STT: ${MIN_STT_BYTES}B`);
  console.log("Encoding: auto-detect on first packet");
}

// ---------------------------------------------------------------------------
// Silence frame
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

function startKeepalive(ws, streamSid) {
  let total = 0;
  const iv = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { clearInterval(iv); return; }
    for (let i = 0; i < KEEPALIVE_FRAMES_PER_BURST; i++) { sendSilenceFrame(ws, streamSid); total++; }
  }, KEEPALIVE_INTERVAL_MS);
  return () => { clearInterval(iv); console.log(`[KA] stopped — ${total} frames`); };
}

// ---------------------------------------------------------------------------
// Stream ffmpeg → Exotel
// ---------------------------------------------------------------------------
function streamPCMFromFFmpeg(ff, ws, streamSid, stopKA) {
  return new Promise(resolve => {
    let rem = Buffer.alloc(0), sent = 0, stopped = false;
    const doStop = () => { if (!stopped && stopKA) { stopKA(); stopped = true; } };

    ff.stdout.on("data", chunk => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      doStop();
      const buf = Buffer.concat([rem, chunk]);
      let off = 0;
      while (off + FRAME_BYTES <= buf.length) {
        try { ws.send(JSON.stringify({ event: "media", stream_sid: streamSid, media: { payload: buf.slice(off, off + FRAME_BYTES).toString("base64") } })); sent++; }
        catch (e) { console.warn("[STREAM] err:", e.message); break; }
        off += FRAME_BYTES;
      }
      rem = buf.slice(off);
    });

    ff.stdout.on("end", () => {
      doStop();
      if (rem.length && ws?.readyState === WebSocket.OPEN) {
        const pad = Buffer.concat([rem, Buffer.alloc(FRAME_BYTES - (rem.length % FRAME_BYTES), PCM_SILENCE_BYTE)]);
        try { ws.send(JSON.stringify({ event: "media", stream_sid: streamSid, media: { payload: pad.toString("base64") } })); sent++; } catch (_) {}
      }
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: "tts_done" } })); } catch (_) {}
      }
      console.log(`[STREAM] ${sent} frames / ~${((sent * FRAME_BYTES) / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE)).toFixed(1)}s`);
      resolve();
    });

    ff.stderr.on("data", d => { const m = d.toString().trim(); if (m) console.warn("[FF]", m); });
    ff.on("error", err => { doStop(); console.error("[FF]", err.message); resolve(); });
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
// TTS
// ---------------------------------------------------------------------------
async function ttsViaElevenLabsStreaming(text, ws, streamSid, stopKA) {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error("no ELEVENLABS_API_KEY");
  const vid = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log("[TTS/EL] ->", text.slice(0, 60));
  const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0", "-ar", String(PCM_SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1"]);
  const done = streamPCMFromFFmpeg(ff, ws, streamSid, stopKA);
  const response = await axios({
    method: "post",
    url: `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`,
    data: { text, model_id: "eleven_turbo_v2", output_format: "mp3_44100_128", voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 } },
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    responseType: "stream", timeout: 20000,
  });
  response.data.pipe(ff.stdin);
  response.data.on("error", e => { console.warn("[TTS/EL] err:", e.message); ff.stdin.end(); });
  ff.stdin.on("error", () => {});
  await done;
}

async function ttsViaCamb(text, ws, streamSid, stopKA) {
  if (!process.env.CAM_API_KEY) throw new Error("no CAM_API_KEY");
  console.log("[TTS/CAMB] ->", text.slice(0, 60));
  const res = await axios.post(
    "https://client.camb.ai/apis/tts-stream",
    { text, language: "en-in", voice_id: parseInt(process.env.CAMB_VOICE_ID || "147320", 10), speech_model: "mars-flash", voice_settings: { speaking_rate: 1.05 } },
    { headers: { "x-api-key": process.env.CAM_API_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 12000 }
  );
  const audio = Buffer.from(res.data);
  if (audio.length < 100) throw new Error(`CAMB too small: ${audio.length}B`);
  console.log(`[TTS/CAMB] ${audio.length}B`);
  const fmt = audio.slice(0, 4).toString("ascii") === "RIFF" ? "wav" : "mp3";
  await convertAndStream(audio, ws, streamSid, fmt, stopKA);
}

async function streamTTS(text, ws, streamSid, session) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !streamSid) { console.warn("[TTS] skip"); return; }
  console.log("[TTS] ->", text.slice(0, 80));
  if (session) session.isSpeaking = true;
  const stopKA = startKeepalive(ws, streamSid);
  let ok = false;
  for (const [name, key, fn] of [
    ["ElevenLabs", "ELEVENLABS_API_KEY", () => ttsViaElevenLabsStreaming(text, ws, streamSid, stopKA)],
    ["CAMB.AI",    "CAM_API_KEY",        () => ttsViaCamb(text, ws, streamSid, stopKA)],
  ]) {
    if (!process.env[key]) continue;
    try { await fn(); ok = true; console.log("[TTS] done via", name); break; }
    catch (e) { console.warn(`[TTS] ${name} failed:`, e.message.slice(0, 100)); }
  }
  stopKA();
  if (!ok) console.error("[TTS] all providers failed");
  if (session) {
    session.isSpeaking = false;
    if (session.bargeinChunks.length > 0 && !session.isProcessing) {
      const audio = Buffer.concat(session.bargeinChunks);
      session.bargeinChunks = [];
      const thresh = getEnergyThresh(session.encoding);
      console.log(`[BARGE-IN] ${audio.length}B energy=${pcmEnergy(audio).toFixed(0)}`);
      if (audio.length >= MIN_STT_BYTES * 2 && pcmEnergy(audio) >= thresh) {
        processUtterance(audio, session, ws).catch(e => console.error("[BARGE-IN]", e.message));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// STT — encoding-aware Deepgram URL
// ---------------------------------------------------------------------------
async function speechToText(pcmBuf, encoding) {
  const energy  = pcmEnergy(pcmBuf).toFixed(0);
  const seconds = (pcmBuf.length / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE)).toFixed(2);
  // For raw linear16 or decoded audio, always send as linear16
  const dgEncoding = "linear16";
  console.log(`[STT] ${pcmBuf.length}B (${seconds}s) energy=${energy} encoding=${encoding}->${dgEncoding}`);
  try {
    const res = await axios.post(
      `https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&encoding=${dgEncoding}&sample_rate=8000&language=en-IN`,
      pcmBuf,
      {
        headers: { Authorization: "Token " + process.env.DEEPGRAM_API_KEY, "Content-Type": "audio/l16;rate=8000" },
        maxBodyLength: Infinity, timeout: 15000,
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
      { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, timeout: 8000 }
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
// Core pipeline
// ---------------------------------------------------------------------------
async function processUtterance(pcmBuf, session, ws) {
  if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) { console.warn("[UTT] ws closed"); return; }
  const t0 = Date.now();
  session.isProcessing = true;
  const seconds = (pcmBuf.length / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE)).toFixed(2);
  console.log(`[UTT] start — ${pcmBuf.length}B (${seconds}s PCM)`);
  try {
    const transcript = await speechToText(pcmBuf, session.encoding);
    if (!transcript || transcript.trim().length < 2) { console.log("[UTT] empty transcript — skip"); return; }
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) { console.warn("[UTT] ws closed after STT"); return; }
    const reply = await getAIResponse(session.history, transcript);
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) { console.warn("[UTT] ws closed after AI"); return; }
    console.log(`[UTT] STT+AI in ${Date.now() - t0}ms`);
    await streamTTS(reply, ws, session.streamSid, session);
    console.log(`[UTT] total ${Date.now() - t0}ms`);
  } catch (e) {
    console.error("[UTT] error:", e.message);
  } finally {
    session.isProcessing = false;
    if (session.pendingFlush) {
      session.pendingFlush = false;
      const pending = Buffer.concat(session.audioChunks);
      session.audioChunks = [];
      const thresh = getEnergyThresh(session.encoding);
      if (pending.length >= MIN_STT_BYTES * 2 && pcmEnergy(pending) >= thresh) {
        console.log(`[UTT] draining deferred: ${pending.length}B`);
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
    encoding:         null,   // detected on first packet
    energyThresh:     500,    // updated after encoding detected
    audioChunks:      [],     // decoded linear16 PCM
    bargeinChunks:    [],     // decoded linear16 PCM
    isProcessing:     false,
    isSpeaking:       false,
    pendingFlush:     false,
    greetingSent:     false,
    silenceTimer:     null,
    wsOpen:           true,
    mediaPacketCount: 0,
  };
  sessions.set(callId, session);

  async function flushAudio(trigger) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
    if (session.audioChunks.length === 0) { console.log(`[VAD] flush(${trigger}) — no audio`); return; }

    const pcm     = Buffer.concat(session.audioChunks);
    session.audioChunks = [];
    const energy  = pcmEnergy(pcm);
    const seconds = (pcm.length / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE)).toFixed(2);
    const thresh  = session.energyThresh;
    console.log(`[VAD] flush(${trigger}) ${pcm.length}B ${seconds}s energy=${energy.toFixed(0)} thresh=${thresh}`);

    if (pcm.length < MIN_STT_BYTES * 2) { console.log("[VAD] too short — skip"); return; }
    if (energy < thresh)                { console.log("[VAD] silence — skip"); return; }
    if (session.isProcessing)           { session.audioChunks = [pcm]; session.pendingFlush = true; console.log("[VAD] busy — pendingFlush"); return; }

    await processUtterance(pcm, session, ws);
  }

  function maybeGreet() {
    if (session.greetingSent || !session.streamSid) return;
    session.greetingSent = true;
    session.history.push({ role: "assistant", content: GREETING });
    console.log("[GREET] firing TTS");
    streamTTS(GREETING, ws, session.streamSid, session).catch(e => { console.error("[GREET]", e.message); if (session) session.isSpeaking = false; });
  }

  ws.on("message", async rawMsg => {
    let data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    if (data.event === "connected") console.log(`[WS] connected | ${callId}`);

    if (data.event === "start") {
      const sid = data.stream_sid || data.streamSid || data.start?.stream_sid || data.start?.streamSid || null;
      if (sid) session.streamSid = sid;
      console.log(`[WS] start | streamSid=${session.streamSid}`);
      maybeGreet();
    }

    if (data.event === "media") {
      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.mediaPacketCount++;

      // Detect encoding on first packet
      if (session.mediaPacketCount === 1) {
        session.encoding     = detectEncoding(rawBytes);
        session.energyThresh = getEnergyThresh(session.encoding);
        console.log(`[DETECT] Using encoding=${session.encoding} energyThresh=${session.energyThresh}`);
      }

      // Grab streamSid from media if missed in start event
      if (!session.streamSid) {
        const sid = data.stream_sid || data.media?.stream_sid || null;
        if (sid) { session.streamSid = sid; console.log(`[WS] streamSid from media: ${session.streamSid}`); }
      }
      if (!session.greetingSent && session.streamSid) maybeGreet();

      // Decode to linear16 PCM regardless of source encoding
      const pcmFrame = decodeAudio(rawBytes, session.encoding);

      if (session.mediaPacketCount <= 10 || session.mediaPacketCount % 200 === 0) {
        const energy = pcmEnergy(pcmFrame);
        console.log(`[MEDIA] pkt#${session.mediaPacketCount} rawEnergy=${pcmEnergy(rawBytes).toFixed(0)} pcmEnergy=${energy.toFixed(0)} speaking=${session.isSpeaking}`);
      }

      if (session.isSpeaking) { session.bargeinChunks.push(pcmFrame); return; }

      session.audioChunks.push(pcmFrame);
      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(() => flushAudio("silence-timer"), SILENCE_TIMEOUT_MS);
    }

    if (data.event === "stop") {
      clearTimeout(session.silenceTimer);
      console.log(`[WS] stop | ${callId} | pkts=${session.mediaPacketCount}`);
      flushAudio("stop-event").catch(e => console.error("[STOP]", e.message));
    }

    if (data.event === "mark") console.log("[WS] mark:", data.mark?.name || data.mark);
  });

  ws.on("close", code => { session.wsOpen = false; clearTimeout(session.silenceTimer); console.log(`[WS] closed | ${callId} | code=${code}`); sessions.delete(callId); });
  ws.on("error", err  => { session.wsOpen = false; console.error(`[WS] error | ${callId}:`, err.message); });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  const tts = [];
  if (process.env.ELEVENLABS_API_KEY) tts.push("ElevenLabs");
  if (process.env.CAM_API_KEY)        tts.push("CAMB.AI");
  res.json({ status: "ok", sessions: sessions.size, uptime: Math.floor(process.uptime()), tts, pipeline: "auto-detect -> decode -> linear16 -> deepgram" });
});

checkEnv();
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
