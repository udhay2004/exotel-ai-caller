require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

console.log("=== ENV CHECK ===");
console.log("ANTHROPIC_API_KEY  :", process.env.ANTHROPIC_API_KEY   ? "✅ SET" : "❌ MISSING");
console.log("DEEPGRAM_API_KEY   :", process.env.DEEPGRAM_API_KEY    ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_API_KEY :", process.env.ELEVENLABS_API_KEY  ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_VOICE_ID:", process.env.ELEVENLABS_VOICE_ID ? "✅ " + process.env.ELEVENLABS_VOICE_ID : "❌ MISSING");
console.log("ffmpegPath         :", ffmpegPath || "❌ NOT FOUND");
console.log("=================\n");

const sessions = {};

const COMPANY_CONTEXT = `
You are a professional telecaller from Connect Ventures Services Pvt Ltd.
Speak short, max 2 sentences. Ask one question at a time.
No pricing, no legal advice. Be friendly and natural.
`;

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

// ─── MULAW CHUNK CONSTANTS ────────────────────────────────────────────────────
// At 8000 Hz mulaw (1 byte per sample):
//   160 bytes = 20ms frame  ← standard telephony frame size
//   We send chunks every 20ms to pace the audio correctly.
//   Blasting all chunks at once causes buffer overflow → ghost/distortion.
const MULAW_FRAME_BYTES = 160;   // 20ms at 8kHz
const MULAW_FRAME_MS    = 20;    // send one frame every 20ms

// ─── FFMPEG: Convert any audio → 8kHz mono mulaw ─────────────────────────────
function convertToMulaw(inputBuffer, inputFormat = null) {
  return new Promise((resolve, reject) => {
    console.log("[FFMPEG] Input:", inputBuffer.length, "bytes | format hint:", inputFormat || "auto");

    const args = ["-y"];

    // If we know the format (e.g. mp3), tell ffmpeg explicitly to avoid probe errors
    if (inputFormat) args.push("-f", inputFormat);

    args.push(
      "-i",    "pipe:0",
      "-ar",   "8000",       // 8kHz sample rate (telephony standard)
      "-ac",   "1",          // mono
      "-acodec", "pcm_mulaw",// G.711 μ-law codec
      "-f",    "mulaw",      // raw mulaw output (no container)
      "pipe:1"
    );

    const ff = spawn(ffmpegPath, args);
    const chunks = [];
    let stderr = "";

    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => { stderr += d.toString(); });

    ff.on("close", (code) => {
      if (chunks.length > 0) {
        const out = Buffer.concat(chunks);
        console.log("[FFMPEG] ✅ Output:", out.length, "bytes");
        resolve(out);
      } else {
        console.error("[FFMPEG] ❌ No output | code:", code);
        console.error("[FFMPEG] stderr tail:", stderr.slice(-600));
        reject(new Error("ffmpeg produced no output"));
      }
    });

    ff.on("error", (err) => {
      console.error("[FFMPEG] spawn error:", err.message);
      reject(err);
    });

    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

// ─── TTS: ElevenLabs → MP3 buffer ────────────────────────────────────────────
async function textToSpeechElevenLabs(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  if (!voiceId || !apiKey) throw new Error("ElevenLabs credentials missing");

  console.log("[TTS] ElevenLabs → voice:", voiceId);
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      // eleven_turbo_v2 is faster and cleaner than eleven_monolingual_v1
      model_id: "eleven_turbo_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.0, use_speaker_boost: true },
    },
    {
      headers: {
        "xi-api-key":   apiKey,
        "Content-Type": "application/json",
        // Request mp3 at 44.1kHz — ffmpeg will downsample to 8kHz mulaw
        "Accept":       "audio/mpeg",
      },
      responseType: "arraybuffer",
      timeout: 20000,
    }
  );

  const buf = Buffer.from(res.data);

  // ElevenLabs returns JSON error as a buffer starting with '{'
  if (buf[0] === 0x7b) {
    const errMsg = buf.toString("utf8").slice(0, 300);
    console.error("[TTS] ElevenLabs returned JSON error:", errMsg);
    throw new Error("ElevenLabs API error: " + errMsg);
  }

  console.log("[TTS] ✅ ElevenLabs MP3:", buf.length, "bytes");
  return { buffer: buf, format: "mp3" };
}

// ─── TTS: Google Translate fallback → MP3 buffer ─────────────────────────────
async function textToSpeechGoogle(text) {
  console.log("[TTS] Google TTS fallback...");
  const encoded = encodeURIComponent(text);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en-IN&client=tw-ob&ttsspeed=0.9`;

  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      "Referer":    "https://translate.google.com/",
      "Accept":     "audio/mpeg, audio/*",
    },
  });

  const buf = Buffer.from(res.data);
  if (buf.length < 100) throw new Error("Google TTS returned empty/invalid audio");

  console.log("[TTS] ✅ Google TTS MP3:", buf.length, "bytes");
  return { buffer: buf, format: "mp3" };
}

// ─── TTS orchestrator ─────────────────────────────────────────────────────────
async function textToSpeech(text) {
  // Try ElevenLabs first, fall back to Google
  try {
    return await textToSpeechElevenLabs(text);
  } catch (err) {
    console.warn("[TTS] ElevenLabs failed:", err.message, "→ trying Google TTS");
  }
  try {
    return await textToSpeechGoogle(text);
  } catch (err) {
    console.error("[TTS] Google TTS failed:", err.message);
    return null;
  }
}

// ─── STT: Deepgram ────────────────────────────────────────────────────────────
async function speechToText(buffer) {
  console.log("[STT] Sending", buffer.length, "bytes to Deepgram");
  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=en-IN&punctuate=true&model=nova-2",
      buffer,
      {
        headers: {
          Authorization:  `Token ${process.env.DEEPGRAM_API_KEY}`,
          "Content-Type": "application/octet-stream",
        },
        timeout: 15000,
      }
    );
    const alt        = res.data?.results?.channels?.[0]?.alternatives?.[0];
    const transcript = alt?.transcript || "";
    const confidence = alt?.confidence || 0;
    console.log("[STT] Transcript:", JSON.stringify(transcript), "| confidence:", confidence.toFixed(2));
    return transcript;
  } catch (err) {
    console.error("[STT] Deepgram error:", err.response?.status, JSON.stringify(err.response?.data) || err.message);
    return "";
  }
}

// ─── AI: Claude ───────────────────────────────────────────────────────────────
async function getAIResponse(callId, text) {
  if (!sessions[callId]) sessions[callId] = { history: [] };
  const history = sessions[callId].history;
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
          "x-api-key":          process.env.ANTHROPIC_API_KEY,
          "anthropic-version":  "2023-06-01",
          "content-type":       "application/json",
        },
        timeout: 18000,
      }
    );

    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log("[AI] Reply:", reply);
    return reply;
  } catch (err) {
    console.error("[AI] Claude error:", err.response?.status, JSON.stringify(err.response?.data) || err.message);
    return "Could you please repeat that?";
  }
}

// ─── SEND AUDIO to Exotel (PACED — this is the key fix for distortion) ────────
//
// WHY PACING MATTERS:
//   Exotel's telephony buffer expects mulaw frames at real-time rate (8kHz).
//   If you dump the entire audio at once, Exotel's jitter buffer overflows,
//   causing the "ghost shouting" distortion you heard.
//   Solution: send one 20ms frame every 20ms — exactly real-time rate.
//
async function sendAudioToExotel(ws, streamSid, text) {
  console.log(`[SEND] Preparing audio | stream_sid=${streamSid} | text="${text.slice(0, 60)}"`);

  try {
    // 1. TTS → MP3 buffer
    const ttsResult = await textToSpeech(text);
    if (!ttsResult) { console.error("[SEND] ❌ TTS produced nothing"); return; }

    // 2. MP3 → 8kHz mono mulaw (raw bytes, no container)
    const mulaw = await convertToMulaw(ttsResult.buffer, ttsResult.format);
    console.log(`[SEND] mulaw total: ${mulaw.length} bytes ≈ ${(mulaw.length / 8000).toFixed(2)}s`);

    // 3. Send in 160-byte (20ms) frames with 20ms inter-frame delay
    //    This replicates real-time audio streaming and prevents buffer overflow.
    let frameCount = 0;
    for (let i = 0; i < mulaw.length; i += MULAW_FRAME_BYTES) {
      if (ws.readyState !== WebSocket.OPEN) {
        console.warn("[SEND] WS closed mid-send at frame", frameCount);
        break;
      }

      const frame = mulaw.slice(i, i + MULAW_FRAME_BYTES);

      ws.send(JSON.stringify({
        event:      "media",
        stream_sid: streamSid,
        media:      { payload: frame.toString("base64") },
      }));

      frameCount++;

      // Pace: wait 20ms before sending the next frame
      // This matches real-time telephony rate exactly
      await new Promise((r) => setTimeout(r, MULAW_FRAME_MS));
    }

    // 4. Send mark event so Exotel knows audio stream is done
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event:      "mark",
        stream_sid: streamSid,
        mark:       { name: "audio_done" },
      }));
    }

    console.log(`[SEND] ✅ Done — ${frameCount} frames (${MULAW_FRAME_BYTES}B each) sent`);
  } catch (err) {
    console.error("[SEND] ❌ Error:", err.message);
  }
}

// ─── WebSocket handler ────────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const callId = Math.random().toString(36).substring(7);
  const ip     = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] ✅ New connection | callId=${callId} | IP=${ip}`);

  sessions[callId] = {
    history:       [],
    streamSid:     null,
    audioChunks:   [],
    silenceTimer:  null,
    isProcessing:  false,
    greetingSent:  false,
    msgCount:      0,
  };

  ws.on("message", async (msg) => {
    const session = sessions[callId];
    if (!session) return;
    session.msgCount++;

    let data;
    try { data = JSON.parse(msg.toString()); }
    catch { console.warn("[WS] Non-JSON message:", msg.toString().slice(0, 100)); return; }

    // Log first few events for debugging
    if (session.msgCount <= 5) {
      console.log(`[WS] Event #${session.msgCount} raw:`, JSON.stringify(data).slice(0, 500));
    }

    switch (data.event) {

      case "connected":
        console.log("[WS] connected ✓");
        break;

      case "start": {
        // Exotel uses stream_sid (underscore). Some versions use streamSid. Check both.
        const sid = data.stream_sid
          || data.start?.stream_sid
          || data.streamSid
          || data.start?.streamSid;

        session.streamSid = sid;
        console.log(`[WS] start ✓ | stream_sid=${sid} | from=${data.start?.from} → to=${data.start?.to}`);

        if (!session.greetingSent) {
          session.greetingSent = true;
          await sendAudioToExotel(ws, session.streamSid, GREETING);
          session.history.push({ role: "assistant", content: GREETING });
        }
        break;
      }

      case "media": {
        // If start event was missed, extract streamSid from media event
        if (!session.streamSid) {
          session.streamSid = data.stream_sid || data.streamSid || `fallback-${callId}`;
          console.warn("[WS] Got streamSid from media event:", session.streamSid);
        }

        // Send greeting if we somehow missed the start event
        if (!session.greetingSent) {
          session.greetingSent = true;
          sendAudioToExotel(ws, session.streamSid, GREETING).then(() => {
            session.history.push({ role: "assistant", content: GREETING });
          });
          return;
        }

        // Don't accumulate audio while AI is replying
        if (session.isProcessing) return;

        // Accumulate mulaw audio chunks
        const chunk = Buffer.from(data.media.payload, "base64");
        session.audioChunks.push(chunk);

        // Silence detection: wait 1.5s of no new audio before processing
        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        session.silenceTimer = setTimeout(async () => {
          if (!session.audioChunks.length || session.isProcessing) return;

          session.isProcessing = true;
          const audio = Buffer.concat(session.audioChunks);
          session.audioChunks = [];

          console.log(`[WS] Silence detected → processing ${audio.length} bytes`);

          // Skip very short clips (< ~400ms) — likely background noise
          if (audio.length < 3200) {
            console.log("[WS] Audio too short (<3200 bytes), skipping");
            session.isProcessing = false;
            return;
          }

          const text = await speechToText(audio);
          if (!text || text.trim().length < 2) {
            console.log("[WS] Empty or trivial transcript, skipping");
            session.isProcessing = false;
            return;
          }

          const reply = await getAIResponse(callId, text);
          await sendAudioToExotel(ws, session.streamSid, reply);
          session.isProcessing = false;
        }, 1500);

        break;
      }

      case "stop":
        console.log(`[WS] stop | callId=${callId}`);
        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        break;

      case "mark":
        // Exotel echoes back our mark events — safe to ignore
        break;

      default:
        console.log("[WS] Unknown event:", data.event, JSON.stringify(data).slice(0, 200));
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] ❌ Closed | callId=${callId} | code=${code} | reason=${reason}`);
    if (sessions[callId]?.silenceTimer) clearTimeout(sessions[callId].silenceTimer);
    delete sessions[callId];
  });

  ws.on("error", (err) => console.error(`[WS] Error | callId=${callId}:`, err.message));
});

// ─── HTTP routes ──────────────────────────────────────────────────────────────
app.get("/",     (req, res) => res.json({ status: "ok", activeSessions: Object.keys(sessions).length }));
app.get("/ping", (req, res) => res.send("pong"));

server.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`   WebSocket : wss://exotel-ai-caller.onrender.com`);
  console.log(`   Health    : https://exotel-ai-caller.onrender.com/\n`);
});
