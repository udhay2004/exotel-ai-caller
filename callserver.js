require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 10000;

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const MULAW_FRAME_BYTES   = 160;   // 20ms @ 8kHz mulaw = 160 bytes
const SILENCE_TIMEOUT_MS  = 1200;  // wait 1.2s of silence before STT
const MIN_AUDIO_BYTES     = 3200;  // ignore clips shorter than ~400ms (8000 bytes/s × 0.4)
const MULAW_SILENCE_BYTE  = 0xFF;  // mulaw encoding of silence / zero-crossing
const SILENCE_ENERGY_THRESH = 5;   // mean absolute deviation from silence byte; below = silence

const COMPANY_CONTEXT =
  "You are a professional telecaller from Connect Ventures. " +
  "Keep every response to 1-2 short sentences. Do not use lists or bullet points. " +
  "Be warm, clear, and concise. Never repeat what the caller just said.";

const GREETING =
  "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const sessions = new Map();

// ─────────────────────────────────────────────
// Utility: compute mean energy of a mulaw buffer
// mulaw silence = 0xFF; active speech deviates from it
// ─────────────────────────────────────────────
function mulawEnergy(buf) {
  if (!buf || buf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += Math.abs(buf[i] - MULAW_SILENCE_BYTE);
  }
  return sum / buf.length;
}

// ─────────────────────────────────────────────
// Utility: strip WAV header if present
// ElevenLabs sometimes prepends a 44-byte WAV/RIFF header even for
// raw mulaw requests. Sending the header bytes as audio causes the
// loud click / noise at the start of every TTS response.
// ─────────────────────────────────────────────
function stripWavHeader(buf) {
  // RIFF header starts with 0x52 0x49 0x46 0x46 ("RIFF")
  if (buf.length > 44 &&
      buf[0] === 0x52 && buf[1] === 0x49 &&
      buf[2] === 0x46 && buf[3] === 0x46) {
    console.log("[STRIP] WAV header detected and removed (44 bytes)");
    return buf.slice(44);
  }
  return buf;
}

// ─────────────────────────────────────────────
// TTS — ElevenLabs streaming mulaw
//
// FIX 1: Remove the conflicting "Accept: audio/wav" header.
//         output_format "ulaw_8000" already tells ElevenLabs what
//         to return. The Accept header was causing the 401 + wrong
//         container format in the original code.
// FIX 2: Strip WAV header bytes before framing.
// FIX 3: Accept a "cancelled" flag so we can abort mid-stream when
//         the WS closes to avoid the "mid-send" log spam.
// ─────────────────────────────────────────────
async function streamTTS(text, ws, streamSid, session) {
  console.log(`[TTS] Requesting ElevenLabs for: "${text.slice(0, 60)}"`);

  try {
    const response = await axios({
      method: "post",
      url: `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream`,
      data: {
        text,
        model_id: "eleven_turbo_v2",
        output_format: "ulaw_8000",          // raw mulaw, 8kHz, mono
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      },
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        // ✅ FIX: removed "Accept: audio/wav" — it contradicted ulaw_8000
        //         and caused ElevenLabs to return a WAV container (with header)
        //         while also triggering the 401 on some account tiers.
      },
      responseType: "stream",
    });

    let audioBuffer = Buffer.alloc(0);
    let firstChunk = true;
    let framesSent = 0;

    return new Promise((resolve, reject) => {
      response.data.on("data", (chunk) => {
        // Check WS is still alive before doing any work
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          response.data.destroy();
          return resolve();
        }

        audioBuffer = Buffer.concat([audioBuffer, chunk]);

        // ✅ FIX: strip WAV header from the very first chunk if present
        if (firstChunk) {
          audioBuffer = stripWavHeader(audioBuffer);
          firstChunk = false;
        }

        // Slice into 160-byte mulaw frames and send each
        while (audioBuffer.length >= MULAW_FRAME_BYTES) {
          if (ws.readyState !== WebSocket.OPEN) break;

          const frame = audioBuffer.slice(0, MULAW_FRAME_BYTES);
          audioBuffer = audioBuffer.slice(MULAW_FRAME_BYTES);

          try {
            ws.send(
              JSON.stringify({
                event: "media",
                stream_sid: streamSid,
                media: { payload: frame.toString("base64") },
              })
            );
            framesSent++;
          } catch (sendErr) {
            console.warn("[TTS] Send error (WS closed mid-stream):", sendErr.message);
            response.data.destroy();
            return resolve();
          }
        }
      });

      response.data.on("end", () => {
        // Send any remaining bytes padded to a full frame with silence
        if (audioBuffer.length > 0 && ws.readyState === WebSocket.OPEN) {
          const padded = Buffer.alloc(MULAW_FRAME_BYTES, MULAW_SILENCE_BYTE);
          audioBuffer.copy(padded);
          try {
            ws.send(
              JSON.stringify({
                event: "media",
                stream_sid: streamSid,
                media: { payload: padded.toString("base64") },
              })
            );
            framesSent++;
          } catch (_) {}
        }

        // Send a mark event so Exotel knows we're done speaking
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(
              JSON.stringify({
                event: "mark",
                stream_sid: streamSid,
                mark: { name: "tts_done" },
              })
            );
          } catch (_) {}
        }

        console.log(`[TTS] ✅ Done — sent ${framesSent} frames (${framesSent * MULAW_FRAME_BYTES} bytes)`);
        resolve();
      });

      response.data.on("error", (err) => {
        console.error("[TTS] Stream error:", err.message);
        reject(err);
      });
    });

  } catch (err) {
    // ✅ FIX: detailed error logging so you can see if it's 401 (bad key),
    //         400 (bad voice ID), or a network issue
    const status = err?.response?.status;
    const detail = err?.response?.data
      ? JSON.stringify(err.response.data).slice(0, 200)
      : err.message;
    console.error(`[TTS] ElevenLabs error — HTTP ${status || "?"}: ${detail}`);

    if (status === 401) {
      console.error("[TTS] ❌ 401 Unauthorized — check ELEVENLABS_API_KEY in your .env");
    } else if (status === 404) {
      console.error("[TTS] ❌ 404 Not Found — check ELEVENLABS_VOICE_ID in your .env");
    }

    // Graceful no-op: caller hears silence rather than a crash
  }
}

// ─────────────────────────────────────────────
// STT — Deepgram
//
// FIX: The original code stored raw base64 strings from
//      data.media.payload and concatenated them with Buffer.concat —
//      but Buffer.concat on base64-decoded buffers is fine IF you decode
//      first. The decode now happens in the media event handler below,
//      so by the time the buffer arrives here it is genuine mulaw bytes.
// ─────────────────────────────────────────────
async function speechToText(buffer) {
  try {
    console.log(`[STT] Sending ${buffer.length} bytes to Deepgram`);
    const response = await axios.post(
      "https://api.deepgram.com/v1/listen" +
        "?model=nova-2&smart_format=true&encoding=mulaw&sample_rate=8000&language=en-IN",
      buffer,
      {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          "Content-Type": "audio/mulaw",   // ✅ explicit content-type
        },
        maxBodyLength: Infinity,
        timeout: 8000,
      }
    );

    const transcript =
      response.data?.results?.channels[0]?.alternatives[0]?.transcript || "";
    const confidence =
      response.data?.results?.channels[0]?.alternatives[0]?.confidence || 0;

    console.log(`[STT] Transcript (conf ${confidence.toFixed(2)}): "${transcript}"`);
    return transcript;
  } catch (err) {
    console.error("[STT] Deepgram error:", err?.response?.status, err.message);
    return "";
  }
}

// ─────────────────────────────────────────────
// AI — Claude via Anthropic API
// ─────────────────────────────────────────────
async function getAIResponse(history, text) {
  history.push({ role: "user", content: text });

  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",   // faster & cheaper for live calls
        max_tokens: 120,
        system: COMPANY_CONTEXT,
        messages: history,
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log(`[AI] Reply: "${reply}"`);
    return reply;
  } catch (err) {
    console.error("[AI] Claude error:", err?.response?.status, err.message);
    return "I'm sorry, could you say that again?";
  }
}

// ─────────────────────────────────────────────
// WebSocket handler
// ─────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const callId = Math.random().toString(36).substring(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[WS] ✅ New connection | callId=${callId} | IP=${clientIP}`);

  const session = {
    callId,
    history: [],
    streamSid: null,
    // ✅ FIX: store decoded mulaw bytes, not base64 strings
    audioChunks: [],
    isProcessing: false,
    greetingSent: false,
    silenceTimer: null,
    wsOpen: true,
  };
  sessions.set(callId, session);

  ws.on("message", async (rawMsg) => {
    let data;
    try {
      data = JSON.parse(rawMsg);
    } catch {
      return;
    }

    // ── connected ──────────────────────────────
    if (data.event === "connected") {
      console.log(`[WS] ✓ Connected event | callId=${callId}`);
    }

    // ── start ──────────────────────────────────
    if (data.event === "start") {
      session.streamSid = data.start?.stream_sid || data.stream_sid;
      console.log(`[WS] ✓ Start event | streamSid=${session.streamSid}`);

      if (!session.greetingSent) {
        session.greetingSent = true;
        console.log("[WS] Sending greeting...");
        // Push greeting into history BEFORE speaking
        session.history.push({ role: "assistant", content: GREETING });
        await streamTTS(GREETING, ws, session.streamSid, session);
      }
    }

    // ── media ──────────────────────────────────
    if (data.event === "media") {
      // Skip if we're already processing a reply
      if (session.isProcessing) return;

      // ✅ FIX (Bug 1): decode base64 → raw mulaw bytes HERE, not later
      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.audioChunks.push(rawBytes);

      // Reset silence timer on every incoming chunk
      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(async () => {
        if (session.isProcessing) return;

        // Concatenate all accumulated mulaw bytes
        const audio = Buffer.concat(session.audioChunks);
        session.audioChunks = [];

        // ✅ FIX (Bug 2): reject clips that are too short
        if (audio.length < MIN_AUDIO_BYTES) {
          console.log(`[VAD] Clip too short (${audio.length}B) — skipping`);
          return;
        }

        // ✅ FIX (Bug 2): reject clips that are silence / background noise
        const energy = mulawEnergy(audio);
        if (energy < SILENCE_ENERGY_THRESH) {
          console.log(`[VAD] Silence detected (energy=${energy.toFixed(2)}) — skipping`);
          return;
        }

        console.log(`[VAD] Speech detected — energy=${energy.toFixed(2)}, size=${audio.length}B`);

        session.isProcessing = true;

        try {
          const transcript = await speechToText(audio);

          if (transcript && transcript.trim().length > 2) {
            const reply = await getAIResponse(session.history, transcript);
            if (session.wsOpen && ws.readyState === WebSocket.OPEN) {
              await streamTTS(reply, ws, session.streamSid, session);
            }
          } else {
            console.log("[VAD] Transcript empty or too short — ignoring");
          }
        } catch (err) {
          console.error("[SESSION] Processing error:", err.message);
        } finally {
          session.isProcessing = false;
        }
      }, SILENCE_TIMEOUT_MS);
    }

    // ── stop ───────────────────────────────────
    if (data.event === "stop") {
      console.log(`[WS] ✓ Stop event | callId=${callId}`);
      clearTimeout(session.silenceTimer);
    }
  });

  // ── WS close ────────────────────────────────
  ws.on("close", (code, reason) => {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log(`[WS] ❌ Closed | callId=${callId} | code=${code} | reason=${reason}`);
    sessions.delete(callId);
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error | callId=${callId}:`, err.message);
    session.wsOpen = false;
  });
});

// ─────────────────────────────────────────────
// Health check endpoint (Render/Railway keep-alive)
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    activeSessions: sessions.size,
    uptime: Math.floor(process.uptime()),
  });
});

// ─────────────────────────────────────────────
// Startup env-var check — fail loud if anything is missing
// ─────────────────────────────────────────────
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
  console.log("   Voice ID:", process.env.ELEVENLABS_VOICE_ID);
  console.log("   Deepgram key:", process.env.DEEPGRAM_API_KEY?.slice(0, 8) + "...");
  console.log("   Anthropic key:", process.env.ANTHROPIC_API_KEY?.slice(0, 8) + "...");
}

checkEnv();
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
