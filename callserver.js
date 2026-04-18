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

// ─────────────────────────────────────────────────────────────────────────
// FIX SUMMARY (4 bugs fixed):
//
// BUG 1 [CRITICAL - GARBLED AUDIO]: ffmpeg was told to expect raw s16le PCM
//   but CAMB.AI /tts-stream actually returns a WAV file (ignores output_configuration).
//   The 44-byte WAV header was being decoded as audio → instant noise/garbling.
//   FIX: Use `-f wav` input format in ffmpeg so it reads the WAV container correctly.
//
// BUG 2 [GARBLED AUDIO]: CAMB.AI `language: "en-in"` is not supported by
//   `mars-flash` model. It silently degrades the output format.
//   FIX: Use `language: "en"` with mars-flash.
//
// BUG 3 [FRAMES DROPPED]: Exotel WebSocket protocol uses `streamSid` (camelCase)
//   in outbound media payloads, but code was sending `stream_sid` (snake_case).
//   FIX: Changed all ws.send() payloads to use `streamSid`.
//
// BUG 4 [CALL DROPS]: ElevenLabs fallback was using `responseType: "arraybuffer"`
//   then wrapping in Buffer — fine, but the mp3 format + high sample rate caused
//   longer ffmpeg startup. FIX: Request pcm_16000 from ElevenLabs directly.
// ─────────────────────────────────────────────────────────────────────────

const MULAW_FRAME_BYTES     = 160;   // 20ms of audio at 8kHz mulaw
const SILENCE_TIMEOUT_MS    = 1200;
const MIN_AUDIO_BYTES       = 3200;
const MULAW_SILENCE_BYTE    = 0xFF;
const SILENCE_ENERGY_THRESH = 5;

const COMPANY_CONTEXT =
  "You are a professional telecaller from Connect Ventures. " +
  "Keep every response to 1-2 short sentences. " +
  "Be warm, clear, and concise. Never repeat what the caller just said. " +
  "Do not use lists, bullet points, or special characters.";

const GREETING =
  "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const sessions = new Map();

// ─────────────────────────────────────────────────────────────────────────
// Startup check
// ─────────────────────────────────────────────────────────────────────────
function checkEnv() {
  const required = ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY"];
  const missing  = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("❌ Missing required env vars:", missing.join(", "));
    process.exit(1);
  }

  const cambKey = process.env["CAM_API_KEY"];
  const elKey   = process.env["ELEVENLABS_API_KEY"];

  if (!cambKey && !elKey) {
    console.error("❌ No TTS provider! Add CAM_API_KEY or ELEVENLABS_API_KEY.");
    process.exit(1);
  }

  const providers = [];
  if (cambKey) providers.push("CAMB.AI (mars-flash)");
  if (elKey)   providers.push("ElevenLabs");

  console.log("✅ Env OK | TTS cascade:", providers.join(" → "));
}

// ─────────────────────────────────────────────────────────────────────────
// Send silent frames so Exotel knows stream is alive during TTS loading.
//
// FIX: Changed `stream_sid` → `streamSid` in all ws.send payloads.
// Exotel's media stream protocol requires camelCase `streamSid`.
// ─────────────────────────────────────────────────────────────────────────
function sendKeepAlive(ws, streamSid, frameCount = 5) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const silenceFrame = Buffer.alloc(MULAW_FRAME_BYTES, MULAW_SILENCE_BYTE);
  const payload      = silenceFrame.toString("base64");
  for (let i = 0; i < frameCount; i++) {
    try {
      ws.send(JSON.stringify({
        event:     "media",
        streamSid: streamSid,           // ✅ FIXED: was stream_sid
        media:     { payload },
      }));
    } catch (_) {}
  }
  console.log(`[KEEPALIVE] Sent ${frameCount} silent frames`);
}

// ─────────────────────────────────────────────────────────────────────────
// STREAMING mulaw sender — sends frames as ffmpeg produces them in real time.
// ─────────────────────────────────────────────────────────────────────────
function streamMulawFromFFmpeg(ffProcess, ws, streamSid) {
  return new Promise((resolve) => {
    let remainder = Buffer.alloc(0);
    let sent      = 0;

    ffProcess.stdout.on("data", (chunk) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const buf = Buffer.concat([remainder, chunk]);
      let offset = 0;

      while (offset + MULAW_FRAME_BYTES <= buf.length) {
        const frame = buf.slice(offset, offset + MULAW_FRAME_BYTES);
        offset += MULAW_FRAME_BYTES;
        try {
          ws.send(JSON.stringify({
            event:     "media",
            streamSid: streamSid,       // ✅ FIXED: was stream_sid
            media:     { payload: frame.toString("base64") },
          }));
          sent++;
        } catch (e) {
          console.warn("[STREAM] send failed:", e.message);
          return;
        }
      }

      remainder = buf.slice(offset);
    });

    ffProcess.stdout.on("end", () => {
      if (remainder.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        const pad = Buffer.alloc(MULAW_FRAME_BYTES, MULAW_SILENCE_BYTE);
        remainder.copy(pad);
        try {
          ws.send(JSON.stringify({
            event:     "media",
            streamSid: streamSid,       // ✅ FIXED: was stream_sid
            media:     { payload: pad.toString("base64") },
          }));
          sent++;
        } catch (_) {}
      }

      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            event:     "mark",
            streamSid: streamSid,       // ✅ FIXED: was stream_sid
            mark:      { name: "tts_done" },
          }));
        } catch (_) {}
      }

      const dur = (sent * MULAW_FRAME_BYTES) / 8000;
      console.log(`[STREAM] ✅ ${sent} frames / ~${dur.toFixed(1)}s sent`);
      resolve();
    });

    ffProcess.stderr.on("data", (e) => {
      const m = e.toString().trim();
      // Only log actual errors, not ffmpeg info lines
      if (m && !m.startsWith("ffmpeg version") && !m.includes("configuration:")) {
        console.warn("[FFMPEG]", m);
      }
    });

    ffProcess.on("error", (err) => {
      console.error("[FFMPEG] spawn error:", err.message);
      resolve();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// TTS PROVIDER 1 — CAMB.AI
//
// BUG FIX 1: CAMB.AI /tts-stream returns a WAV file regardless of the
//   `output_configuration.format` field — that field is silently ignored.
//   The previous code told ffmpeg to expect raw s16le PCM, but the stream
//   started with a 44-byte WAV header → those bytes decoded as audio = NOISE.
//
//   FIX: Use `-f wav -i pipe:0` so ffmpeg reads the WAV container properly.
//   We no longer need to specify `-f s16le -ar 8000 -ac 1` for the input
//   because ffmpeg reads all that from the WAV header automatically.
//
// BUG FIX 2: `language: "en-in"` is not supported by mars-flash.
//   FIX: Use `language: "en"`.
// ─────────────────────────────────────────────────────────────────────────
async function streamTTSbyCamb(text, ws, streamSid) {
  const apiKey = process.env["CAM_API_KEY"];
  if (!apiKey) throw new Error("CAM_API_KEY not set");

  const voiceId = parseInt(process.env.CAMB_VOICE_ID || "147320", 10);
  console.log(`[TTS/CAMB] voice=${voiceId} | "${text.slice(0, 60)}"`);

  // ✅ FIXED: Input format is now `wav` (not `s16le`).
  // CAMB.AI streams a WAV file — ffmpeg must be told to expect WAV.
  // No need to specify -ar or -ac for input; WAV header provides that info.
  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f",      "wav",        // ✅ FIXED: was `-f s16le -ar 8000 -ac 1`
    "-i",      "pipe:0",
    "-ar",     "8000",
    "-ac",     "1",
    "-acodec", "pcm_mulaw",
    "-f",      "mulaw",
    "pipe:1",
  ]);

  const sendPromise = streamMulawFromFFmpeg(ff, ws, streamSid);

  let res;
  try {
    res = await axios.post(
      "https://client.camb.ai/apis/tts-stream",
      {
        text,
        language:     "en",            // ✅ FIXED: was "en-in" (unsupported by mars-flash)
        voice_id:     voiceId,
        speech_model: "mars-flash",
        // Note: output_configuration.format is ignored by CAMB.AI's streaming endpoint.
        // It always returns WAV. The ffmpeg fix above handles this.
        voice_settings:    { speaking_rate: 1.05 },
        inference_options: { stability: 0.6, temperature: 0.7, speaker_similarity: 0.7 },
      },
      {
        headers:      { "x-api-key": apiKey, "Content-Type": "application/json" },
        responseType: "stream",
        timeout:      20000,
      }
    );
  } catch (err) {
    ff.kill();
    throw err;
  }

  res.data.pipe(ff.stdin);
  res.data.on("error", (e) => {
    console.warn("[TTS/CAMB] stream error:", e.message);
    ff.stdin.end();
  });
  res.data.on("end", () => {
    ff.stdin.end();
    console.log("[TTS/CAMB] ✅ CAMB.AI stream finished");
  });

  await sendPromise;
}

// ─────────────────────────────────────────────────────────────────────────
// TTS PROVIDER 2 — ElevenLabs fallback
//
// FIX: Request pcm_8000 directly instead of mp3_44100.
//   - Avoids mp3 decoding overhead
//   - ffmpeg doesn't need to resample from 44100 → 8000
//   - Faster, fewer conversion artifacts
// ─────────────────────────────────────────────────────────────────────────
async function streamTTSbyElevenLabs(text, ws, streamSid) {
  const apiKey  = process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const voiceId = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log(`[TTS/EL] voice=${voiceId} | "${text.slice(0, 60)}"`);

  const res = await axios({
    method: "post",
    url:    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    data: {
      text,
      model_id:       "eleven_turbo_v2",
      output_format:  "pcm_16000",     // ✅ FIXED: raw PCM at 16kHz, no container overhead
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
    },
    headers:      { "xi-api-key": apiKey, "Content-Type": "application/json" },
    responseType: "arraybuffer",
    timeout:      15000,
  });

  const pcmBuf = Buffer.from(res.data);
  console.log(`[TTS/EL] ✅ ${pcmBuf.length}B pcm16k — converting`);

  await new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f",  "s16le",    // raw signed 16-bit little-endian PCM
      "-ar", "16000",    // ElevenLabs pcm_16000 = 16kHz
      "-ac", "1",
      "-i",  "pipe:0",
      "-ar", "8000",     // resample to 8kHz for mulaw
      "-ac", "1",
      "-acodec", "pcm_mulaw",
      "-f",      "mulaw",
      "pipe:1",
    ]);
    const sendP = streamMulawFromFFmpeg(ff, ws, streamSid);
    Readable.from(pcmBuf).pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    sendP.then(resolve).catch(reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Master TTS function — cascade with keep-alive
// ─────────────────────────────────────────────────────────────────────────
async function streamTTS(text, ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  console.log(`[TTS] → "${text.slice(0, 80)}"`);

  sendKeepAlive(ws, streamSid, 5);

  const providers = [
    { name: "CAMB.AI",    fn: () => streamTTSbyCamb(text, ws, streamSid) },
    { name: "ElevenLabs", fn: () => streamTTSbyElevenLabs(text, ws, streamSid) },
  ];

  for (const p of providers) {
    try {
      await p.fn();
      console.log(`[TTS] ✅ Done via ${p.name}`);
      return;
    } catch (err) {
      console.warn(`[TTS] ❌ ${p.name}: ${err.message.slice(0, 150)}`);
    }
  }

  console.error("[TTS] 🚨 All providers failed — sending silence");
  const buf = Buffer.alloc(16000, MULAW_SILENCE_BYTE);
  let offset = 0;
  while (offset + MULAW_FRAME_BYTES <= buf.length && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        event:     "media",
        streamSid: streamSid,           // ✅ FIXED: was stream_sid
        media:     { payload: buf.slice(offset, offset + MULAW_FRAME_BYTES).toString("base64") },
      }));
    } catch (_) { break; }
    offset += MULAW_FRAME_BYTES;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// VAD
// ─────────────────────────────────────────────────────────────────────────
function mulawEnergy(buf) {
  if (!buf || !buf.length) return 0;
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += Math.abs(buf[i] - MULAW_SILENCE_BYTE);
  return s / buf.length;
}

// ─────────────────────────────────────────────────────────────────────────
// STT — Deepgram nova-2
// ─────────────────────────────────────────────────────────────────────────
async function speechToText(buffer) {
  try {
    console.log(`[STT] Sending ${buffer.length}B`);
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen" +
        "?model=nova-2&smart_format=true&encoding=mulaw&sample_rate=8000&language=en-IN",
      buffer,
      {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          "Content-Type": "audio/mulaw",
        },
        maxBodyLength: Infinity,
        timeout: 8000,
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

// ─────────────────────────────────────────────────────────────────────────
// AI — Claude Haiku
// ─────────────────────────────────────────────────────────────────────────
async function getAIResponse(history, text) {
  history.push({ role: "user", content: text });
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system:     COMPANY_CONTEXT,
        messages:   history,
      },
      {
        headers: {
          "x-api-key":         process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 10000,
      }
    );
    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log(`[AI] "${reply}"`);
    return reply;
  } catch (err) {
    console.error("[AI]", err?.response?.status, err.message);
    return "I'm sorry, could you say that again?";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// WebSocket — Exotel handler
// ─────────────────────────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const callId   = Math.random().toString(36).substring(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] ✅ New call | callId=${callId} | IP=${clientIP}`);

  const session = {
    callId,
    history:      [],
    streamSid:    null,
    audioChunks:  [],
    isProcessing: false,
    greetingSent: false,
    silenceTimer: null,
    wsOpen:       true,
  };
  sessions.set(callId, session);

  ws.on("message", async (rawMsg) => {
    let data;
    try { data = JSON.parse(rawMsg); } catch { return; }

    if (data.event === "connected") {
      console.log(`[WS] connected | ${callId}`);
    }

    if (data.event === "start") {
      // Exotel sends streamSid in different places depending on SDK version
      session.streamSid = data.start?.stream_sid
                       || data.start?.streamSid
                       || data.streamSid
                       || data.stream_sid;
      console.log(`[WS] start | streamSid=${session.streamSid}`);

      if (!session.greetingSent) {
        session.greetingSent = true;
        session.history.push({ role: "assistant", content: GREETING });
        streamTTS(GREETING, ws, session.streamSid).catch((e) =>
          console.error("[GREETING]", e.message)
        );
      }
    }

    if (data.event === "media") {
      if (session.isProcessing) return;

      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.audioChunks.push(rawBytes);

      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(async () => {
        if (session.isProcessing) return;

        const audio = Buffer.concat(session.audioChunks);
        session.audioChunks = [];

        if (audio.length < MIN_AUDIO_BYTES) {
          console.log(`[VAD] Too short (${audio.length}B)`);
          return;
        }

        const energy = mulawEnergy(audio);
        if (energy < SILENCE_ENERGY_THRESH) {
          console.log(`[VAD] Silence (energy=${energy.toFixed(2)})`);
          return;
        }

        console.log(`[VAD] ✅ Speech | energy=${energy.toFixed(2)} | ${audio.length}B`);
        session.isProcessing = true;

        try {
          const transcript = await speechToText(audio);
          if (transcript && transcript.trim().length > 2) {
            const reply = await getAIResponse(session.history, transcript);
            if (session.wsOpen && ws.readyState === WebSocket.OPEN) {
              await streamTTS(reply, ws, session.streamSid);
            }
          } else {
            console.log("[VAD] Empty transcript — skipping");
          }
        } catch (err) {
          console.error("[SESSION]", err.message);
        } finally {
          session.isProcessing = false;
        }
      }, SILENCE_TIMEOUT_MS);
    }

    if (data.event === "stop") {
      console.log(`[WS] stop | ${callId}`);
      clearTimeout(session.silenceTimer);
    }
  });

  ws.on("close", (code) => {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log(`[WS] closed | ${callId} | code=${code}`);
    sessions.delete(callId);
  });

  ws.on("error", (err) => {
    session.wsOpen = false;
    console.error(`[WS] error | ${callId}:`, err.message);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const tts = [];
  if (process.env["CAM_API_KEY"])        tts.push("CAMB.AI");
  if (process.env["ELEVENLABS_API_KEY"]) tts.push("ElevenLabs");
  res.json({ status: "ok", sessions: sessions.size, uptime: Math.floor(process.uptime()), tts });
});

checkEnv();
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
