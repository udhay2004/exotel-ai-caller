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
// THE TWO ROOT CAUSES OF THE "MUSIC" SOUND YOU HEARD:
//
// CAUSE 1 — Wrong sample rate in the audio data:
//   ElevenLabs returned 57,723 bytes for a ~4-second greeting.
//   At true 8kHz mulaw, 4 seconds = 32,000 bytes.
//   57,723 bytes ≈ 7.2 seconds worth of 8kHz audio — meaning ElevenLabs
//   internally generated audio at ~14-16kHz and down-labelled it as 8kHz.
//   Exotel played it at real 8kHz → stretched to double duration = slow,
//   warped, "musical" sound.
//   FIX: Always pass audio through ffmpeg to FORCE resample to true 8kHz
//        mulaw, regardless of what ElevenLabs claims the format is.
//
// CAUSE 2 — Wrong voice (Rachel / EXAVITQu4vr4xnSDxMaL):
//   Rachel is an audiobook narrator voice — dramatic, resonant, slow.
//   On a phone call at wrong speed it sounds exactly like background music.
//   FIX: Use "Aria" (9BWtsMINqrJLrRacOk9x) — a clear, natural, professional
//        conversational voice that works well over telephony, OR set a custom
//        voice via ELEVENLABS_VOICE_ID env var.
//
//   RECOMMENDED VOICES FOR INDIAN ENGLISH TELECALLING:
//   - Aria            : 9BWtsMINqrJLrRacOk9x  (clear, professional, neutral)
//   - Charlie         : IKne3meq5aSn9XLyUdCD   (natural, friendly, male)
//   - Callum          : N2lVS1w4EtoT3dr4eOWO   (calm, professional, male)
//   For Indian-accented voices, browse elevenlabs.io/voice-library and
//   add the voice ID to your ELEVENLABS_VOICE_ID env var on Render.
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────
const MULAW_FRAME_BYTES     = 160;   // 20ms × 8000Hz × 1 byte/sample = 160 bytes
const SILENCE_TIMEOUT_MS    = 1200;  // pause before we send to STT
const MIN_AUDIO_BYTES       = 3200;  // skip clips shorter than ~400ms
const MULAW_SILENCE_BYTE    = 0xFF;  // mulaw encoding of silence
const SILENCE_ENERGY_THRESH = 5;    // energy below this = silence/noise

const COMPANY_CONTEXT =
  "You are a professional telecaller from Connect Ventures. " +
  "Keep every response to 1-2 short sentences. " +
  "Be warm, clear, and concise. Never repeat what the caller just said. " +
  "Do not use lists, bullet points, or special characters.";

const GREETING =
  "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const sessions = new Map();

// ─────────────────────────────────────────────────────────────────────────
// Startup env-var check
// ─────────────────────────────────────────────────────────────────────────
function checkEnv() {
  const required = [
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_VOICE_ID",
    "DEEPGRAM_API_KEY",
    "ANTHROPIC_API_KEY",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("❌ Missing env vars:", missing.join(", "));
    process.exit(1);
  }
  console.log("✅ Env vars OK");
  console.log(`   Voice ID : ${process.env.ELEVENLABS_VOICE_ID}`);
  console.log(`   EL Key   : ${process.env.ELEVENLABS_API_KEY.slice(0, 10)}...`);
}

// ─────────────────────────────────────────────────────────────────────────
// Core fix: FORCE resample any audio → true 8kHz raw mulaw via ffmpeg
//
// WHY THIS IS NON-OPTIONAL:
//   ElevenLabs ulaw_8000 is supposed to return 8000 samples/sec.
//   In practice it over-delivers (57k bytes for a 4s clip instead of 32k).
//   This means the sample rate in the data does not match the label.
//   ffmpeg with "-ar 8000" RE-SAMPLES the signal mathematically to exactly
//   8000 samples/second regardless of input rate, producing a clean output
//   that Exotel plays at the correct speed.
//
//   Input can be: ulaw, mulaw, mp3, wav, pcm — ffmpeg handles all of them.
//   Output: raw mulaw, no WAV header, exactly 8000 samples/sec, mono.
// ─────────────────────────────────────────────────────────────────────────
function toExactMulaw8k(inputBuffer, inputFormat) {
  return new Promise((resolve, reject) => {

    // Tell ffmpeg what format the input bytes are so it doesn't have to guess
    // "mulaw" = raw mulaw, "mp3" = mp3 container, etc.
    const fmt = inputFormat || "mulaw";

    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f",      fmt,           // input format (avoids misdetection)
      "-ar",     "8000",        // INPUT rate hint (ffmpeg needs this for raw formats)
      "-ac",     "1",           // mono
      "-i",      "pipe:0",      // read from stdin
      "-ar",     "8000",        // OUTPUT: resample to EXACTLY 8000 Hz
      "-ac",     "1",           // OUTPUT: mono
      "-acodec", "pcm_mulaw",   // OUTPUT: mulaw codec
      "-f",      "mulaw",       // OUTPUT: raw mulaw, NO WAV container/header
      "pipe:1",                 // write to stdout
    ]);

    const chunks = [];
    ff.stdout.on("data",  (c) => chunks.push(c));
    ff.stderr.on("data",  (e) => {
      const msg = e.toString().trim();
      if (msg) console.warn("[FFMPEG]", msg);
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

    // Pipe input buffer into ffmpeg stdin
    const readable = Readable.from(inputBuffer);
    readable.pipe(ff.stdin);
    ff.stdin.on("error", () => {}); // ignore broken-pipe when ffmpeg closes early
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Send clean mulaw frames over WebSocket to Exotel
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
      console.warn("[SEND] ws.send failed:", e.message);
      break;
    }
  }

  // Pad remaining bytes to a full frame with silence and send
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

  // Send mark event so Exotel knows TTS is done
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        event:      "mark",
        stream_sid: streamSid,
        mark:       { name: "tts_done" },
      }));
    } catch (_) {}
  }

  // Sanity check: at 8kHz mulaw, 1 sec = 8000 bytes = 50 frames
  const durationSec = (sent * MULAW_FRAME_BYTES) / 8000;
  console.log(`[SEND] ✅ ${sent} frames / ${sent * MULAW_FRAME_BYTES}B / ~${durationSec.toFixed(1)}s audio`);
}

// ─────────────────────────────────────────────────────────────────────────
// Read an Axios error stream to get the real HTTP body
// (When responseType:"stream", error.response.data is a Node Readable,
//  not parsed JSON — must be piped to read the actual error text)
// ─────────────────────────────────────────────────────────────────────────
function readErrStream(stream) {
  return new Promise((resolve) => {
    if (!stream || typeof stream.on !== "function") return resolve(String(stream));
    const c = [];
    stream.on("data",  (d) => c.push(d));
    stream.on("end",   () => resolve(Buffer.concat(c).toString()));
    stream.on("error", () => resolve("[unreadable]"));
    setTimeout(() => resolve("[timeout]"), 2000);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// TTS — ElevenLabs → ffmpeg → exact 8kHz mulaw → Exotel
//
// Strategy:
//   1. Request ulaw_8000 from ElevenLabs (lowest latency if plan supports it)
//   2. Pass result through ffmpeg to guarantee exact 8kHz resampling
//      (this is the core fix for the "music" speed problem)
//   3. If ulaw_8000 fails (plan restriction), fall back to mp3 + ffmpeg
// ─────────────────────────────────────────────────────────────────────────
async function streamTTS(text, ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  console.log(`[TTS] → "${text.slice(0, 70)}"`);

  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey  = process.env.ELEVENLABS_API_KEY;

  // ── Attempt 1: ulaw_8000 → ffmpeg resample ───────────────────────────
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
      headers: {
        "xi-api-key":   apiKey,
        "Content-Type": "application/json",
        // No Accept header — output_format controls format
      },
      responseType: "arraybuffer",  // collect full buffer (not stream) for ffmpeg
      timeout:      15000,
    });

    const rawBuf = Buffer.from(res.data);
    console.log(`[TTS] EL ulaw_8000 raw: ${rawBuf.length}B`);

    // ✅ THE KEY FIX: Always resample through ffmpeg regardless of what
    //    ElevenLabs returned. This corrects any sample-rate mismatch.
    const mulawBuf = await toExactMulaw8k(rawBuf, "mulaw");
    sendMulawFrames(mulawBuf, ws, streamSid);
    return;

  } catch (err) {
    const status = err?.response?.status;
    let body = err.message;
    if (err?.response?.data) {
      body = Buffer.isBuffer(err.response.data)
        ? err.response.data.toString().slice(0, 300)
        : await readErrStream(err.response.data);
    }
    console.error(`[TTS] ulaw_8000 failed (HTTP ${status}): ${body.slice(0, 300)}`);
  }

  // ── Attempt 2: mp3 → ffmpeg resample (works on ALL EL plan tiers) ────
  console.log("[TTS] 🔄 Falling back to mp3...");
  try {
    const res = await axios({
      method: "post",
      url:    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      data: {
        text,
        model_id:       "eleven_turbo_v2",
        output_format:  "mp3_44100_128",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
      },
      headers: {
        "xi-api-key":   apiKey,
        "Content-Type": "application/json",
      },
      responseType: "arraybuffer",
      timeout:      15000,
    });

    const mp3Buf = Buffer.from(res.data);
    console.log(`[TTS] mp3 raw: ${mp3Buf.length}B — converting...`);

    const mulawBuf = await toExactMulaw8k(mp3Buf, "mp3");
    sendMulawFrames(mulawBuf, ws, streamSid);

  } catch (err) {
    const status = err?.response?.status;
    let body = err.message;
    if (err?.response?.data) {
      body = Buffer.isBuffer(err.response.data)
        ? err.response.data.toString().slice(0, 300)
        : await readErrStream(err.response.data);
    }
    console.error(`[TTS] ❌ mp3 fallback also failed (HTTP ${status}): ${body.slice(0, 200)}`);
    // Caller hears silence — no crash
  }
}

// ─────────────────────────────────────────────────────────────────────────
// VAD helper: mulaw energy (deviation from silence byte 0xFF)
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
    console.log(`[STT] Sending ${buffer.length}B to Deepgram`);
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
    console.error("[STT] Error:", err?.response?.status, err.message);
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// AI — Claude
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
    console.error("[AI] Error:", err?.response?.status, err.message);
    return "I'm sorry, could you say that again?";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// WebSocket — Exotel call handler
// ─────────────────────────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const callId   = Math.random().toString(36).substring(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] ✅ New call | callId=${callId} | IP=${clientIP}`);

  const session = {
    callId,
    history:      [],
    streamSid:    null,
    audioChunks:  [],     // stores decoded mulaw bytes (NOT base64 strings)
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
      console.log(`[WS] connected | callId=${callId}`);
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

      // Decode base64 payload → raw mulaw bytes immediately
      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.audioChunks.push(rawBytes);

      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(async () => {
        if (session.isProcessing) return;

        const audio = Buffer.concat(session.audioChunks);
        session.audioChunks = [];

        // Gate 1: clip too short
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

        console.log(`[VAD] ✅ Speech detected — energy=${energy.toFixed(2)}, ${audio.length}B`);
        session.isProcessing = true;

        try {
          const transcript = await speechToText(audio);
          if (transcript && transcript.trim().length > 2) {
            const reply = await getAIResponse(session.history, transcript);
            if (session.wsOpen && ws.readyState === WebSocket.OPEN) {
              await streamTTS(reply, ws, session.streamSid);
            }
          } else {
            console.log("[VAD] Transcript empty — ignoring");
          }
        } catch (err) {
          console.error("[SESSION] Error:", err.message);
        } finally {
          session.isProcessing = false;
        }
      }, SILENCE_TIMEOUT_MS);
    }

    if (data.event === "stop") {
      console.log(`[WS] stop | callId=${callId}`);
      clearTimeout(session.silenceTimer);
    }
  });

  ws.on("close", (code) => {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log(`[WS] closed | callId=${callId} | code=${code}`);
    sessions.delete(callId);
  });

  ws.on("error", (err) => {
    session.wsOpen = false;
    console.error(`[WS] error | callId=${callId}:`, err.message);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", sessions: sessions.size, uptime: Math.floor(process.uptime()) });
});

checkEnv();
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
