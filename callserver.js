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

// ===========================================================================
// CONFIRMED FACTS (from byte analysis across all test calls):
//
//   First packet hex: a800 b800 b800 9800 6800 4800 2800 f8ff
//   As int16 LE:      168,  184,  184,  152,  104,   72,   40,   -8
//   These are small integers = near-silence in LINEAR16 format.
//   pcmEnergy of those = ~120-173, which matches the logs exactly.
//
//   EXOTEL SENDS:    linear16 s16le, 8kHz, mono, 320 bytes per 20ms frame
//   EXOTEL RECEIVES: linear16 s16le, 8kHz, mono, 320 bytes per 20ms frame
//
//   The greeting was audible (doc #5) when code output s16le frames.
//   After switching to mulaw output, caller heard noise. Proof: Exotel needs s16le back.
//
//   STT: send raw linear16 bytes directly to Deepgram — no conversion needed.
//   VAD: pcmEnergy on raw bytes. Silence ≈ 50-200. Speech ≈ 500-8000.
//        Threshold = 300 (safe margin above silence, catches all speech).
//
//   STT was empty because previous versions applied mulaw decode to linear16 bytes,
//   corrupting the audio before sending to Deepgram.
// ===========================================================================

const SAMPLE_RATE    = 8000;
const BYTES_PER_S    = SAMPLE_RATE * 2;   // linear16: 2 bytes/sample = 16000 B/s
const FRAME_BYTES    = 320;               // 20ms of linear16 at 8kHz

const SILENCE_MS     = parseInt(process.env.SILENCE_TIMEOUT || "900",  10);
const ENERGY_THRESH  = parseInt(process.env.ENERGY_THRESH   || "300",  10);
const MIN_SPEECH_MS  = 500;
const MIN_PCM_BYTES  = (MIN_SPEECH_MS / 1000) * BYTES_PER_S; // 8000 bytes = 0.5s

const KEEPALIVE_MS     = 200;
const KEEPALIVE_FRAMES = 10;

const COMPANY_CONTEXT =
  "You are a professional telecaller from Connect Ventures. " +
  "Keep every response to 1-2 short sentences. " +
  "Be warm, clear, and concise. Never repeat what the caller just said. " +
  "Do not use lists, bullet points, or special characters.";

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const sessions = new Map();

// ---------------------------------------------------------------------------
// VAD — linear16 s16le energy (no decode needed)
// ---------------------------------------------------------------------------
function pcmEnergy(buf) {
  if (!buf || buf.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    sum += Math.abs(buf.readInt16LE(i));
  }
  return sum / (buf.length >> 1);
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
  console.log(`Silence: ${SILENCE_MS}ms | Energy thresh: ${ENERGY_THRESH} | Min: ${MIN_SPEECH_MS}ms`);
  console.log("IN/OUT: linear16 s16le 8kHz (Exotel native format)");
}

// ---------------------------------------------------------------------------
// Keepalive — linear16 silence frames (0x00 bytes, 320B each)
// Exotel expects linear16 back, so silence = zero samples
// ---------------------------------------------------------------------------
function sendSilenceFrame(ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({
      event:      "media",
      stream_sid: streamSid,
      media:      { payload: Buffer.alloc(FRAME_BYTES, 0x00).toString("base64") },
    }));
  } catch (_) {}
}

function startKeepalive(ws, streamSid) {
  let total = 0;
  const iv = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { clearInterval(iv); return; }
    for (let i = 0; i < KEEPALIVE_FRAMES; i++) { sendSilenceFrame(ws, streamSid); total++; }
  }, KEEPALIVE_MS);
  return () => { clearInterval(iv); console.log(`[KA] stopped — ${total} frames`); };
}

// ---------------------------------------------------------------------------
// Stream ffmpeg s16le output → Exotel (linear16 frames)
// ---------------------------------------------------------------------------
function streamL16FromFFmpeg(ff, ws, streamSid, stopKA) {
  return new Promise(resolve => {
    let rem = Buffer.alloc(0), sent = 0, stopped = false;
    const doStop = () => { if (!stopped && stopKA) { stopKA(); stopped = true; } };

    ff.stdout.on("data", chunk => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      doStop();
      const buf = Buffer.concat([rem, chunk]);
      let off = 0;
      while (off + FRAME_BYTES <= buf.length) {
        try {
          ws.send(JSON.stringify({
            event: "media", stream_sid: streamSid,
            media: { payload: buf.slice(off, off + FRAME_BYTES).toString("base64") },
          }));
          sent++;
        } catch (e) { console.warn("[STREAM] err:", e.message); break; }
        off += FRAME_BYTES;
      }
      rem = buf.slice(off);
    });

    ff.stdout.on("end", () => {
      doStop();
      if (rem.length && ws?.readyState === WebSocket.OPEN) {
        const pad = Buffer.concat([rem, Buffer.alloc(FRAME_BYTES - (rem.length % FRAME_BYTES), 0x00)]);
        try { ws.send(JSON.stringify({ event: "media", stream_sid: streamSid, media: { payload: pad.toString("base64") } })); sent++; } catch (_) {}
      }
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: "tts_done" } })); } catch (_) {}
      }
      const dur = ((sent * FRAME_BYTES) / BYTES_PER_S).toFixed(1);
      console.log(`[STREAM] ${sent} l16 frames / ~${dur}s`);
      resolve();
    });

    ff.stderr.on("data", d => { const m = d.toString().trim(); if (m) console.warn("[FF]", m); });
    ff.on("error", err => { doStop(); console.error("[FF]", err.message); resolve(); });
  });
}

// Convert TTS audio buffer (mp3 or wav) → s16le 8kHz → stream to Exotel
function convertAndStream(audioBuf, inputFmt, ws, streamSid, stopKA) {
  return new Promise((res, rej) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", inputFmt, "-i", "pipe:0",
      "-ar", "8000", "-ac", "1",
      "-f", "s16le",   // linear16 output — what Exotel expects
      "pipe:1",
    ]);
    Readable.from(audioBuf).pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    streamL16FromFFmpeg(ff, ws, streamSid, stopKA).then(res).catch(rej);
  });
}

// ---------------------------------------------------------------------------
// TTS providers
// ---------------------------------------------------------------------------
async function ttsViaElevenLabs(text, ws, streamSid, stopKA) {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error("no ELEVENLABS_API_KEY");
  const vid = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log("[TTS/EL] ->", text.slice(0, 60));

  // ffmpeg: mp3 stream → s16le 8kHz (linear16 for Exotel)
  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "mp3", "-i", "pipe:0",
    "-ar", "8000", "-ac", "1",
    "-f", "s16le",
    "pipe:1",
  ]);
  const done = streamL16FromFFmpeg(ff, ws, streamSid, stopKA);

  const response = await axios({
    method: "post",
    url: `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`,
    data: {
      text,
      model_id: "eleven_turbo_v2",
      output_format: "mp3_44100_128",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
    },
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    responseType: "stream",
    timeout: 20000,
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
    {
      text,
      language:       "en-in",
      voice_id:       parseInt(process.env.CAMB_VOICE_ID || "147320", 10),
      speech_model:   "mars-flash",
      voice_settings: { speaking_rate: 1.05 },
    },
    { headers: { "x-api-key": process.env.CAM_API_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 15000 }
  );

  const audio = Buffer.from(res.data);
  if (audio.length < 100) throw new Error(`CAMB too small: ${audio.length}B`);
  console.log(`[TTS/CAMB] ${audio.length}B`);
  const fmt = audio.slice(0, 4).toString("ascii") === "RIFF" ? "wav" : "mp3";
  await convertAndStream(audio, fmt, ws, streamSid, stopKA);
}

async function streamTTS(text, ws, streamSid, session) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !streamSid) { console.warn("[TTS] skip"); return; }
  console.log("[TTS] ->", text.slice(0, 80));
  if (session) session.isSpeaking = true;

  const stopKA = startKeepalive(ws, streamSid);
  let ok = false;

  for (const [name, key, fn] of [
    ["ElevenLabs", "ELEVENLABS_API_KEY", () => ttsViaElevenLabs(text, ws, streamSid, stopKA)],
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
    // Process barge-in audio collected while bot was speaking
    if (session.bargeinChunks.length > 0 && !session.isProcessing) {
      const bargein = Buffer.concat(session.bargeinChunks);
      session.bargeinChunks = [];
      const energy = pcmEnergy(bargein);
      console.log(`[BARGE-IN] ${bargein.length}B energy=${energy.toFixed(0)} thresh=${ENERGY_THRESH}`);
      if (bargein.length >= MIN_PCM_BYTES && energy >= ENERGY_THRESH) {
        processUtterance(bargein, session, ws).catch(e => console.error("[BARGE-IN] err:", e.message));
      } else {
        console.log("[BARGE-IN] too quiet or short — skip");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// STT — raw linear16 directly to Deepgram (no decode, no conversion)
// ---------------------------------------------------------------------------
async function speechToText(pcmBuf) {
  const energy  = pcmEnergy(pcmBuf).toFixed(0);
  const seconds = (pcmBuf.length / BYTES_PER_S).toFixed(2);
  console.log(`[STT] ${pcmBuf.length}B (${seconds}s) energy=${energy}`);

  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&encoding=linear16&sample_rate=8000&language=en-IN",
      pcmBuf,
      {
        headers: {
          Authorization:  "Token " + process.env.DEEPGRAM_API_KEY,
          "Content-Type": "audio/l16;rate=8000",
        },
        maxBodyLength: Infinity,
        timeout: 15000,
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
  console.log(`[UTT] start — ${pcmBuf.length}B (${(pcmBuf.length / BYTES_PER_S).toFixed(2)}s)`);
  try {
    const transcript = await speechToText(pcmBuf);
    if (!transcript || transcript.trim().length < 2) { console.log("[UTT] empty — skip"); return; }
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) return;
    const reply = await getAIResponse(session.history, transcript);
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) return;
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
      if (pending.length >= MIN_PCM_BYTES && pcmEnergy(pending) >= ENERGY_THRESH) {
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
  const callId   = Math.random().toString(36).slice(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] New call | ${callId} | ${clientIP}`);

  const session = {
    callId,
    history:       [],
    streamSid:     null,
    audioChunks:   [],   // raw linear16 frames from Exotel
    bargeinChunks: [],   // linear16 frames collected while bot speaks
    isProcessing:  false,
    isSpeaking:    false,
    pendingFlush:  false,
    greetingSent:  false,
    silenceTimer:  null,
    wsOpen:        true,
    pktCount:      0,
  };
  sessions.set(callId, session);

  async function flushAudio(trigger) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
    if (session.audioChunks.length === 0) { console.log(`[VAD] flush(${trigger}) — no audio`); return; }

    const pcm     = Buffer.concat(session.audioChunks);
    session.audioChunks = [];
    const energy  = pcmEnergy(pcm);
    const seconds = (pcm.length / BYTES_PER_S).toFixed(2);
    console.log(`[VAD] flush(${trigger}) ${pcm.length}B ${seconds}s energy=${energy.toFixed(0)} thresh=${ENERGY_THRESH}`);

    if (pcm.length < MIN_PCM_BYTES) { console.log("[VAD] too short — skip"); return; }
    if (energy < ENERGY_THRESH)     { console.log("[VAD] silence — skip"); return; }
    if (session.isProcessing)       { session.audioChunks = [pcm]; session.pendingFlush = true; console.log("[VAD] busy — pendingFlush"); return; }

    await processUtterance(pcm, session, ws);
  }

  function maybeGreet() {
    if (session.greetingSent || !session.streamSid) return;
    session.greetingSent = true;
    session.history.push({ role: "assistant", content: GREETING });
    console.log("[GREET] firing TTS");
    streamTTS(GREETING, ws, session.streamSid, session).catch(e => {
      console.error("[GREET]", e.message);
      if (session) session.isSpeaking = false;
    });
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
      // Exotel sends raw linear16 s16le, 8kHz, mono, 320 bytes per frame
      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.pktCount++;

      // Recover streamSid if missed from start event
      if (!session.streamSid) {
        const sid = data.stream_sid || data.media?.stream_sid || null;
        if (sid) { session.streamSid = sid; console.log(`[WS] streamSid from media: ${session.streamSid}`); }
      }
      if (!session.greetingSent && session.streamSid) maybeGreet();

      // Log first packet
      if (session.pktCount === 1) {
        const e = pcmEnergy(rawBytes);
        console.log(`[AUDIO] First pkt: ${rawBytes.length}B | pcmEnergy=${e.toFixed(0)} | hex=${rawBytes.slice(0, 16).toString("hex")}`);
      }
      if (session.pktCount <= 10 || session.pktCount % 200 === 0) {
        console.log(`[MEDIA] pkt#${session.pktCount} pcmEnergy=${pcmEnergy(rawBytes).toFixed(0)} speaking=${session.isSpeaking}`);
      }

      if (session.isSpeaking) { session.bargeinChunks.push(rawBytes); return; }

      session.audioChunks.push(rawBytes);
      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(() => flushAudio("silence-timer"), SILENCE_MS);
    }

    if (data.event === "stop") {
      clearTimeout(session.silenceTimer);
      console.log(`[WS] stop | ${callId} | pkts=${session.pktCount}`);
      flushAudio("stop-event").catch(e => console.error("[STOP]", e.message));
    }

    if (data.event === "mark") console.log("[WS] mark:", data.mark?.name || data.mark);
  });

  ws.on("close", code => {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log(`[WS] closed | ${callId} | code=${code}`);
    sessions.delete(callId);
  });
  ws.on("error", err => { session.wsOpen = false; console.error(`[WS] error | ${callId}:`, err.message); });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  const tts = [];
  if (process.env.ELEVENLABS_API_KEY) tts.push("ElevenLabs");
  if (process.env.CAM_API_KEY)        tts.push("CAMB.AI");
  res.json({ status: "ok", sessions: sessions.size, uptime: Math.floor(process.uptime()), tts, energy_thresh: ENERGY_THRESH, format: "linear16 s16le 8kHz in/out" });
});

checkEnv();
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
