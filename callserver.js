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
// ENV VAR NAMES (exactly as saved in Render):
//
//   CAM_API_KEY        → your CAMB.AI key  ← PRIMARY TTS (add this now)
//   ELEVENLABS_API_KEY → EL key            ← FALLBACK (kept just in case)
//   ELEVENLABS_VOICE_ID                    ← EL voice (optional)
//   DEEPGRAM_API_KEY                       ← STT (required)
//   ANTHROPIC_API_KEY                      ← AI  (required)
//
// CAMB.AI optional overrides:
//   CAMB_VOICE_ID  → integer voice ID (default: 147320)
//                    Browse voices at studio.camb.ai → Voice Library
// ─────────────────────────────────────────────────────────────────────────

const MULAW_FRAME_BYTES     = 160;
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
    console.error("❌ No TTS provider! Add 'CAM_API_KEY' to Render env vars.");
    console.error("   Get key at: studio.camb.ai → API section");
    process.exit(1);
  }

  const providers = [];
  if (cambKey) providers.push("CAMB.AI (mars-flash)");
  if (elKey)   providers.push("ElevenLabs");

  console.log("✅ Env OK | TTS cascade:", providers.join(" → "));
  console.log(`   CAMB.AI key : ${cambKey ? cambKey.slice(0, 10) + "..." : "NOT SET ⚠️"}`);
}

// ─────────────────────────────────────────────────────────────────────────
// ffmpeg: any audio format → exact 8kHz raw mulaw
// ─────────────────────────────────────────────────────────────────────────
function toExactMulaw8k(inputBuffer, inputFormat) {
  return new Promise((resolve, reject) => {
    const fmt   = inputFormat || "wav";
    const isRaw = fmt === "mulaw"; // raw formats need explicit rate hint

    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", fmt,
      ...(isRaw ? ["-ar", "8000", "-ac", "1"] : []),
      "-i", "pipe:0",
      "-ar", "8000",
      "-ac", "1",
      "-acodec", "pcm_mulaw",
      "-f", "mulaw",
      "pipe:1",
    ];

    const ff     = spawn("ffmpeg", args);
    const chunks = [];

    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", (e) => {
      const m = e.toString().trim();
      if (m) console.warn("[FFMPEG]", m);
    });
    ff.on("close", (code) => {
      if (code === 0) {
        const out = Buffer.concat(chunks);
        console.log(`[FFMPEG] ✅ ${inputBuffer.length}B ${fmt} → ${out.length}B mulaw@8k`);
        resolve(out);
      } else {
        reject(new Error(`ffmpeg exited ${code}`));
      }
    });
    ff.on("error", reject);

    Readable.from(inputBuffer).pipe(ff.stdin);
    ff.stdin.on("error", () => {});
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Send mulaw frames to Exotel via WebSocket
// ─────────────────────────────────────────────────────────────────────────
function sendMulawFrames(mulawBuf, ws, streamSid) {
  let offset = 0;
  let sent   = 0;

  while (offset + MULAW_FRAME_BYTES <= mulawBuf.length) {
    if (!ws || ws.readyState !== WebSocket.OPEN) break;
    const frame = mulawBuf.slice(offset, offset + MULAW_FRAME_BYTES);
    offset += MULAW_FRAME_BYTES;
    try {
      ws.send(JSON.stringify({
        event:      "media",
        stream_sid: streamSid,
        media:      { payload: frame.toString("base64") },
      }));
      sent++;
    } catch (e) {
      console.warn("[SEND] failed:", e.message);
      break;
    }
  }

  // Pad last partial frame
  if (offset < mulawBuf.length && ws && ws.readyState === WebSocket.OPEN) {
    const pad = Buffer.alloc(MULAW_FRAME_BYTES, MULAW_SILENCE_BYTE);
    mulawBuf.slice(offset).copy(pad);
    try {
      ws.send(JSON.stringify({
        event:      "media",
        stream_sid: streamSid,
        media:      { payload: pad.toString("base64") },
      }));
      sent++;
    } catch (_) {}
  }

  // Mark = TTS done signal
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        event:      "mark",
        stream_sid: streamSid,
        mark:       { name: "tts_done" },
      }));
    } catch (_) {}
  }

  const dur = (sent * MULAW_FRAME_BYTES) / 8000;
  console.log(`[SEND] ✅ ${sent} frames / ~${dur.toFixed(1)}s`);
}

// ─────────────────────────────────────────────────────────────────────────
// TTS PROVIDER 1 — CAMB.AI  (mars-flash, ~100ms latency)
//
// Docs: https://docs.camb.ai/api-reference/endpoint/create-tts-stream
// Auth: x-api-key header  (key name in Render: "CAM_API_KEY")
// Output: WAV → ffmpeg → mulaw 8kHz
// ─────────────────────────────────────────────────────────────────────────
async function ttsByCamb(text) {
  const apiKey = process.env["CAM_API_KEY"];
  if (!apiKey) throw new Error("CAM_API_KEY not set");

  const voiceId = parseInt(process.env.CAMB_VOICE_ID || "147320", 10);
  console.log(`[TTS/CAMB] voice=${voiceId} | "${text.slice(0, 60)}"`);

  const res = await axios.post(
    "https://client.camb.ai/apis/tts-stream",
    {
      text,
      language:     "en-in",        // Indian English
      voice_id:     voiceId,
      speech_model: "mars-flash",   // fastest model, ideal for real-time phone calls
      enhance_named_entities_pronunciation: false,
      output_configuration: {
        format:      "wav",
        sample_rate: 8000,           // request 8kHz directly
      },
      voice_settings: {
        speaking_rate: 1.05,         // slightly faster = more natural on phone
      },
      inference_options: {
        stability:          0.6,
        temperature:        0.7,
        speaker_similarity: 0.7,
      },
    },
    {
      headers: {
        "x-api-key":    apiKey,
        "Content-Type": "application/json",
      },
      responseType: "arraybuffer",
      timeout:      20000,
    }
  );

  const wavBuf = Buffer.from(res.data);
  if (wavBuf.length < 100) {
    throw new Error(`CAMB.AI returned too-small buffer: ${wavBuf.length}B`);
  }
  console.log(`[TTS/CAMB] ✅ ${wavBuf.length}B WAV received`);
  return await toExactMulaw8k(wavBuf, "wav");
}

// ─────────────────────────────────────────────────────────────────────────
// TTS PROVIDER 2 — ElevenLabs (fallback, skipped if key missing)
// ─────────────────────────────────────────────────────────────────────────
async function ttsByElevenLabs(text) {
  const apiKey  = process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const voiceId = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log(`[TTS/EL] voice=${voiceId} | "${text.slice(0, 60)}"`);

  // Try ulaw_8000 first
  try {
    const res = await axios({
      method: "post",
      url:    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      data: {
        text,
        model_id:       "eleven_turbo_v2",
        output_format:  "ulaw_8000",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
      },
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      responseType: "arraybuffer",
      timeout:      15000,
    });
    return await toExactMulaw8k(Buffer.from(res.data), "mulaw");
  } catch (e) {
    console.warn("[TTS/EL] ulaw failed, trying mp3:", e.message.slice(0, 80));
  }

  // mp3 fallback
  const res = await axios({
    method: "post",
    url:    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    data: {
      text,
      model_id:       "eleven_turbo_v2",
      output_format:  "mp3_44100_128",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
    },
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    responseType: "arraybuffer",
    timeout:      15000,
  });
  const mp3 = Buffer.from(res.data);
  console.log(`[TTS/EL] ✅ ${mp3.length}B mp3`);
  return await toExactMulaw8k(mp3, "mp3");
}

// ─────────────────────────────────────────────────────────────────────────
// TTS CASCADE — CAMB.AI → ElevenLabs → silence (call never crashes)
// ─────────────────────────────────────────────────────────────────────────
async function streamTTS(text, ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  console.log(`[TTS] → "${text.slice(0, 80)}"`);

  const providers = [
    { name: "CAMB.AI",    fn: () => ttsByCamb(text) },
    { name: "ElevenLabs", fn: () => ttsByElevenLabs(text) },
  ];

  for (const p of providers) {
    try {
      const mulawBuf = await p.fn();
      console.log(`[TTS] ✅ ${p.name} success — ${mulawBuf.length}B mulaw`);
      sendMulawFrames(mulawBuf, ws, streamSid);
      return;
    } catch (err) {
      console.warn(`[TTS] ❌ ${p.name}: ${err.message.slice(0, 150)}`);
    }
  }

  console.error("[TTS] 🚨 ALL providers failed — sending silence");
  sendMulawFrames(Buffer.alloc(8000, MULAW_SILENCE_BYTE), ws, streamSid);
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
      session.streamSid = data.start?.stream_sid || data.stream_sid;
      console.log(`[WS] start | streamSid=${session.streamSid}`);
      if (!session.greetingSent) {
        session.greetingSent = true;
        session.history.push({ role: "assistant", content: GREETING });
        await streamTTS(GREETING, ws, session.streamSid);
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
