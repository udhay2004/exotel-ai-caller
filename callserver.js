require("dotenv").config();
const express    = require("express");
const http       = require("http");
const WebSocket  = require("ws");
const axios      = require("axios");
const { spawn }  = require("child_process");
const { Readable } = require("stream");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 10000;

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
const MULAW_FRAME_BYTES     = 160;   // 20ms @ 8kHz mulaw
const SILENCE_TIMEOUT_MS    = 1200;  // wait 1.2s of silence before STT
const MIN_AUDIO_BYTES       = 3200;  // ignore clips < 400ms
const MULAW_SILENCE_BYTE    = 0xFF;  // mulaw zero / silence byte
const SILENCE_ENERGY_THRESH = 5;    // mean deviation below = silence

const COMPANY_CONTEXT =
  "You are a professional telecaller from Connect Ventures. " +
  "Keep every response to 1-2 short sentences. Do not use lists or bullet points. " +
  "Be warm, clear, and concise. Never repeat what the caller just said.";

const GREETING =
  "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const sessions = new Map();

// ─────────────────────────────────────────────────────────────
// Env-var check — fail loud at startup, not mid-call
// ─────────────────────────────────────────────────────────────
function checkEnv() {
  const required = [
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_VOICE_ID",
    "DEEPGRAM_API_KEY",
    "ANTHROPIC_API_KEY",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error("❌ Missing required env vars:", missing.join(", "));
    process.exit(1);
  }
  console.log("✅ All env vars present");
  console.log(`   EL Voice  : ${process.env.ELEVENLABS_VOICE_ID}`);
  console.log(`   EL Key    : ${process.env.ELEVENLABS_API_KEY.slice(0, 10)}...`);
  console.log(`   DG Key    : ${process.env.DEEPGRAM_API_KEY.slice(0, 8)}...`);
  console.log(`   ANT Key   : ${process.env.ANTHROPIC_API_KEY.slice(0, 8)}...`);
}

// ─────────────────────────────────────────────────────────────
// Utility: read an Axios error stream to get the REAL error body
//
// ROOT CAUSE OF THE "401 + garbage log" BUG:
// When responseType:"stream" is set, Axios gives you a Node Readable
// stream in BOTH success AND error cases. So err.response.data is a
// stream object, not parsed JSON. The original code did:
//   JSON.stringify(err.response.data) → logged the stream internals
//   (_writeState, _events, etc.) instead of the real HTTP body.
// Fix: pipe the stream to read the actual bytes first.
// ─────────────────────────────────────────────────────────────
function readStreamToString(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    if (!stream || typeof stream.on !== "function") {
      return resolve(String(stream));
    }
    stream.on("data",  (c) => chunks.push(c));
    stream.on("end",   () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", () => resolve("[unreadable stream]"));
    setTimeout(() => resolve("[timeout reading error body]"), 2000);
  });
}

// ─────────────────────────────────────────────────────────────
// Utility: strip WAV/RIFF header (44 bytes) if present
// ElevenLabs sometimes prepends it even for raw format requests.
// Sending header bytes as mulaw audio = loud click / noise.
// ─────────────────────────────────────────────────────────────
function stripWavHeader(buf) {
  if (
    buf.length > 44 &&
    buf[0] === 0x52 && buf[1] === 0x49 &&
    buf[2] === 0x46 && buf[3] === 0x46
  ) {
    console.log("[TTS] WAV header stripped (44 bytes)");
    return buf.slice(44);
  }
  return buf;
}

// ─────────────────────────────────────────────────────────────
// Utility: mulaw energy — real speech vs line noise
// mulaw silence = 0xFF; speech bytes deviate from it
// ─────────────────────────────────────────────────────────────
function mulawEnergy(buf) {
  if (!buf || buf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += Math.abs(buf[i] - MULAW_SILENCE_BYTE);
  return sum / buf.length;
}

// ─────────────────────────────────────────────────────────────
// Utility: send mulaw frames over WebSocket
// Shared by both TTS paths (direct ulaw + ffmpeg-converted)
// ─────────────────────────────────────────────────────────────
function sendMulawFrames(mulawBuf, ws, streamSid) {
  const buf    = stripWavHeader(mulawBuf);
  let offset   = 0;
  let sent     = 0;

  while (offset + MULAW_FRAME_BYTES <= buf.length) {
    if (!ws || ws.readyState !== WebSocket.OPEN) break;
    const frame = buf.slice(offset, offset + MULAW_FRAME_BYTES);
    offset += MULAW_FRAME_BYTES;
    try {
      ws.send(JSON.stringify({
        event:      "media",
        stream_sid: streamSid,
        media:      { payload: frame.toString("base64") },
      }));
      sent++;
    } catch (e) {
      console.warn("[SEND] ws.send error:", e.message);
      break;
    }
  }

  // Pad + send any leftover bytes
  if (offset < buf.length && ws && ws.readyState === WebSocket.OPEN) {
    const padded = Buffer.alloc(MULAW_FRAME_BYTES, MULAW_SILENCE_BYTE);
    buf.slice(offset).copy(padded);
    try {
      ws.send(JSON.stringify({
        event:      "media",
        stream_sid: streamSid,
        media:      { payload: padded.toString("base64") },
      }));
      sent++;
    } catch (_) {}
  }

  // Tell Exotel we are done speaking
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        event:      "mark",
        stream_sid: streamSid,
        mark:       { name: "tts_done" },
      }));
    } catch (_) {}
  }

  console.log(`[SEND] ✅ ${sent} frames / ${sent * MULAW_FRAME_BYTES} bytes sent`);
}

// ─────────────────────────────────────────────────────────────
// Fallback: convert mp3 Buffer → raw mulaw via ffmpeg (in-memory)
// Works on ALL ElevenLabs plan tiers (free, starter, creator, etc.)
// ulaw_8000 output_format requires Creator tier or above.
// ─────────────────────────────────────────────────────────────
function mp3ToMulaw(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i",      "pipe:0",     // read mp3 from stdin
      "-ar",     "8000",       // resample to 8 kHz
      "-ac",     "1",          // mono
      "-acodec", "pcm_mulaw",  // mulaw codec
      "-f",      "mulaw",      // raw mulaw — NO WAV container header
      "pipe:1",                // write to stdout
    ]);

    const chunks = [];
    ff.stdout.on("data",  (c) => chunks.push(c));
    ff.stderr.on("data",  (e) => console.warn("[FFMPEG]", e.toString().trim()));
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    const readable = Readable.from(mp3Buffer);
    readable.pipe(ff.stdin);
    ff.stdin.on("error", () => {});
  });
}

// ─────────────────────────────────────────────────────────────
// PRIMARY TTS  — ulaw_8000 direct (zero conversion, lowest latency)
// FALLBACK TTS — mp3_44100_128 + ffmpeg → mulaw (works on any plan)
// ─────────────────────────────────────────────────────────────
async function streamTTS(text, ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  console.log(`[TTS] "${text.slice(0, 70)}"`);

  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey  = process.env.ELEVENLABS_API_KEY;

  // ── Attempt 1: ulaw_8000 direct ──────────────────────────────
  try {
    const res = await axios({
      method: "post",
      url:    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      data: {
        text,
        model_id:       "eleven_turbo_v2",
        output_format:  "ulaw_8000",
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      },
      headers: {
        "xi-api-key":   apiKey,
        "Content-Type": "application/json",
        // NO Accept header — output_format controls the format.
        // "Accept: audio/wav" in the original code caused:
        //   (a) ElevenLabs to wrap output in a WAV container (with 44-byte header)
        //   (b) 401 on some plan tiers because the combination is invalid
      },
      responseType: "stream",
      timeout:      15000,
    });

    // Collect full stream into buffer
    const chunks = [];
    await new Promise((resolve, reject) => {
      res.data.on("data",  (c) => chunks.push(c));
      res.data.on("end",   resolve);
      res.data.on("error", reject);
    });

    const mulawBuf = Buffer.concat(chunks);
    console.log(`[TTS] ✅ ulaw_8000 — ${mulawBuf.length} bytes`);
    sendMulawFrames(mulawBuf, ws, streamSid);
    return; // done — no fallback needed

  } catch (err) {
    const status = err?.response?.status;

    // Read the REAL error body — err.response.data is a stream when
    // responseType:"stream" is set (this is what was logging garbage before)
    let realBody = err.message;
    if (err?.response?.data) {
      realBody = await readStreamToString(err.response.data);
    }

    console.error(`[TTS] ulaw_8000 failed — HTTP ${status}: ${realBody.slice(0, 400)}`);

    if (status === 401 || status === 422) {
      console.log("[TTS] Plan may not support ulaw_8000 — trying mp3 fallback...");
    }
    // Fall through to mp3 fallback regardless of error type
  }

  // ── Attempt 2: mp3 + ffmpeg → mulaw ──────────────────────────
  console.log("[TTS] 🔄 mp3_44100 fallback...");
  try {
    const res = await axios({
      method: "post",
      url:    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      data: {
        text,
        model_id:       "eleven_turbo_v2",
        output_format:  "mp3_44100_128",   // available on ALL plan tiers
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      },
      headers: {
        "xi-api-key":   apiKey,
        "Content-Type": "application/json",
      },
      responseType: "arraybuffer",         // collect full mp3 at once
      timeout:      15000,
    });

    const mp3Buf = Buffer.from(res.data);
    console.log(`[TTS] mp3 received — ${mp3Buf.length} bytes, converting to mulaw...`);

    const mulawBuf = await mp3ToMulaw(mp3Buf);
    console.log(`[TTS] ✅ mp3→mulaw — ${mulawBuf.length} bytes`);
    sendMulawFrames(mulawBuf, ws, streamSid);

  } catch (err) {
    const status   = err?.response?.status;
    let realBody   = err.message;
    if (err?.response?.data) {
      realBody = Buffer.isBuffer(err.response.data)
        ? err.response.data.toString().slice(0, 300)
        : String(err.response.data).slice(0, 300);
    }
    console.error(`[TTS] ❌ mp3 fallback also failed — HTTP ${status}: ${realBody}`);
    // Caller hears silence — no crash
  }
}

// ─────────────────────────────────────────────────────────────
// STT — Deepgram nova-2
// ─────────────────────────────────────────────────────────────
async function speechToText(buffer) {
  try {
    console.log(`[STT] Sending ${buffer.length} bytes to Deepgram`);
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
    console.log(`[STT] "${transcript}" (conf: ${confidence.toFixed(2)})`);
    return transcript;
  } catch (err) {
    console.error("[STT] Error:", err?.response?.status, err.message);
    return "";
  }
}

// ─────────────────────────────────────────────────────────────
// AI — Claude
// ─────────────────────────────────────────────────────────────
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
    console.log(`[AI] Reply: "${reply}"`);
    return reply;
  } catch (err) {
    console.error("[AI] Error:", err?.response?.status, err.message);
    return "I'm sorry, could you say that again?";
  }
}

// ─────────────────────────────────────────────────────────────
// WebSocket handler
// ─────────────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const callId   = Math.random().toString(36).substring(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[WS] ✅ New connection | callId=${callId} | IP=${clientIP}`);

  const session = {
    callId,
    history:      [],
    streamSid:    null,
    audioChunks:  [],      // decoded mulaw Buffers — NOT base64 strings
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
      console.log(`[WS] ✓ Connected | callId=${callId}`);
    }

    if (data.event === "start") {
      session.streamSid = data.start?.stream_sid || data.stream_sid;
      console.log(`[WS] ✓ Start | streamSid=${session.streamSid}`);
      if (!session.greetingSent) {
        session.greetingSent = true;
        session.history.push({ role: "assistant", content: GREETING });
        await streamTTS(GREETING, ws, session.streamSid);
      }
    }

    if (data.event === "media") {
      if (session.isProcessing) return;

      // ✅ Decode base64 → raw mulaw bytes immediately on arrival
      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.audioChunks.push(rawBytes);

      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(async () => {
        if (session.isProcessing) return;

        const audio = Buffer.concat(session.audioChunks);
        session.audioChunks = [];

        // Gate 1: too short
        if (audio.length < MIN_AUDIO_BYTES) {
          console.log(`[VAD] Too short (${audio.length}B) — skip`);
          return;
        }
        // Gate 2: silence / line noise
        const energy = mulawEnergy(audio);
        if (energy < SILENCE_ENERGY_THRESH) {
          console.log(`[VAD] Silence (energy=${energy.toFixed(2)}) — skip`);
          return;
        }

        console.log(`[VAD] ✅ Speech — energy=${energy.toFixed(2)}, ${audio.length}B`);
        session.isProcessing = true;

        try {
          const transcript = await speechToText(audio);
          if (transcript && transcript.trim().length > 2) {
            const reply = await getAIResponse(session.history, transcript);
            if (session.wsOpen && ws.readyState === WebSocket.OPEN) {
              await streamTTS(reply, ws, session.streamSid);
            }
          } else {
            console.log("[VAD] Transcript too short — ignore");
          }
        } catch (err) {
          console.error("[SESSION] Error:", err.message);
        } finally {
          session.isProcessing = false;
        }
      }, SILENCE_TIMEOUT_MS);
    }

    if (data.event === "stop") {
      console.log(`[WS] ✓ Stop | callId=${callId}`);
      clearTimeout(session.silenceTimer);
    }
  });

  ws.on("close", (code) => {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log(`[WS] ❌ Closed | callId=${callId} | code=${code}`);
    sessions.delete(callId);
  });

  ws.on("error", (err) => {
    session.wsOpen = false;
    console.error(`[WS] Error | callId=${callId}:`, err.message);
  });
});

// ─────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    activeSessions: sessions.size,
    uptime: Math.floor(process.uptime()),
  });
});

checkEnv();
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
