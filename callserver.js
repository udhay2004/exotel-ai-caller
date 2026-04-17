require("dotenv").config();

const express  = require("express");
const http     = require("http");
const WebSocket= require("ws");
const axios    = require("axios");
const { spawn }= require("child_process");
const ffmpegPath = require("ffmpeg-static");
const fs       = require("fs");
const path     = require("path");
const os       = require("os");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 10000;

console.log("=== ENV CHECK ===");
console.log("ANTHROPIC_API_KEY  :", process.env.ANTHROPIC_API_KEY   ? "✅ SET" : "❌ MISSING");
console.log("DEEPGRAM_API_KEY   :", process.env.DEEPGRAM_API_KEY    ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_API_KEY :", process.env.ELEVENLABS_API_KEY  ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_VOICE_ID:", process.env.ELEVENLABS_VOICE_ID ? "✅ " + process.env.ELEVENLABS_VOICE_ID : "❌ MISSING");
console.log("ffmpegPath         :", ffmpegPath || "❌ NOT FOUND");
console.log("=================\n");

const sessions = {};

const COMPANY_CONTEXT = `You are a professional telecaller from Connect Ventures Services Pvt Ltd.
Speak short, max 2 sentences. Ask one question at a time.
No pricing, no legal advice. Be friendly and natural.`;

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

// 20ms frame at 8kHz mulaw = 160 bytes
const MULAW_FRAME_BYTES = 160;
const MULAW_FRAME_MS    = 20;

// ─── FFMPEG via temp files ────────────────────────────────────────────────────
// WHY TEMP FILES: When ffmpeg reads from stdin (pipe:0), it cannot seek
// backwards to detect the audio format from the file header, so it sometimes
// guesses wrong and passes the data through without decoding — producing
// identical input/output sizes and playing raw MP3 bytes as mulaw (ghost noise).
// Writing to a real file lets ffmpeg read the header properly and decode correctly.
async function convertToMulaw(inputBuffer) {
  const tmpIn  = path.join(os.tmpdir(), `cv_in_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  const tmpOut = path.join(os.tmpdir(), `cv_out_${Date.now()}_${Math.random().toString(36).slice(2)}.ul`);

  try {
    fs.writeFileSync(tmpIn, inputBuffer);
    console.log(`[FFMPEG] Input: ${inputBuffer.length} bytes → ${tmpIn}`);

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-y",
        "-i",      tmpIn,        // real file: ffmpeg auto-detects format from header
        "-ar",     "8000",       // 8 kHz sample rate
        "-ac",     "1",          // mono
        "-acodec", "pcm_mulaw",  // G.711 μ-law codec
        "-f",      "mulaw",      // raw mulaw container (no WAV header)
        tmpOut,
      ]);

      let stderr = "";
      ff.stderr.on("data", d => { stderr += d.toString(); });
      ff.on("close", code => {
        if (code === 0 && fs.existsSync(tmpOut)) resolve();
        else {
          console.error("[FFMPEG] ❌ code:", code);
          console.error("[FFMPEG] stderr:", stderr.slice(-1000));
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });
      ff.on("error", reject);
    });

    const out = fs.readFileSync(tmpOut);
    const ratio = (out.length / inputBuffer.length).toFixed(2);
    console.log(`[FFMPEG] ✅ Output: ${out.length} bytes mulaw (ratio: ${ratio}x vs input)`);

    // Guard: if sizes are equal, conversion silently failed
    if (out.length === inputBuffer.length) {
      throw new Error("ffmpeg output size equals input — MP3 was NOT decoded. Check ffmpeg build.");
    }
    if (out.length < 800) {
      throw new Error(`ffmpeg output too small (${out.length} bytes) — likely silence or error`);
    }

    return out;
  } finally {
    try { fs.unlinkSync(tmpIn);  } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ─── TTS: ElevenLabs → MP3 buffer ────────────────────────────────────────────
async function ttsElevenLabs(text) {
  const key     = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) throw new Error("ElevenLabs credentials not set");

  console.log("[TTS] ElevenLabs → voice:", voiceId);
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: "eleven_turbo_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.0, use_speaker_boost: true },
    },
    {
      headers: {
        "xi-api-key":   key,
        "Content-Type": "application/json",
        "Accept":       "audio/mpeg",
      },
      responseType: "arraybuffer",
      timeout: 20000,
    }
  );

  const buf = Buffer.from(res.data);

  // JSON error response starts with '{' (0x7b)
  if (buf[0] === 0x7b) {
    throw new Error("ElevenLabs API error: " + buf.toString("utf8").slice(0, 200));
  }

  // Verify MP3 magic bytes: ID3 tag (49 44 33) or MPEG sync word (ff ex)
  const isMP3 = (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)
             || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
  if (!isMP3) {
    throw new Error(`Unexpected format from ElevenLabs, header: ${buf.slice(0,4).toString("hex")}`);
  }

  console.log(`[TTS] ✅ ElevenLabs MP3: ${buf.length} bytes`);
  return buf;
}

// ─── TTS: Google Translate fallback → MP3 buffer ─────────────────────────────
async function ttsGoogle(text) {
  console.log("[TTS] Google TTS fallback...");
  const encoded = encodeURIComponent(text);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en-IN&client=tw-ob&ttsspeed=0.9`;

  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      "Referer":    "https://translate.google.com/",
    },
  });

  const buf = Buffer.from(res.data);
  console.log(`[TTS] Google response: ${buf.length} bytes, header hex: ${buf.slice(0,8).toString("hex")}`);

  if (buf.length < 200) throw new Error(`Google TTS suspiciously small: ${buf.length} bytes`);

  return buf;
}

// ─── TTS orchestrator ─────────────────────────────────────────────────────────
async function textToSpeech(text) {
  try { return await ttsElevenLabs(text); }
  catch (e) { console.warn("[TTS] ElevenLabs failed:", e.message, "→ Google TTS"); }

  try { return await ttsGoogle(text); }
  catch (e) { console.error("[TTS] Google TTS failed:", e.message); return null; }
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
  } catch (e) {
    console.error("[STT] Error:", e.response?.status, JSON.stringify(e.response?.data) || e.message);
    return "";
  }
}

// ─── AI: Claude ───────────────────────────────────────────────────────────────
async function getAIResponse(callId, text) {
  const session = sessions[callId];
  session.history.push({ role: "user", content: text });
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system:     COMPANY_CONTEXT,
        messages:   session.history,
      },
      {
        headers: {
          "x-api-key":         process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type":      "application/json",
        },
        timeout: 18000,
      }
    );
    const reply = res.data.content[0].text.trim();
    session.history.push({ role: "assistant", content: reply });
    console.log("[AI] Reply:", reply);
    return reply;
  } catch (e) {
    console.error("[AI] Error:", e.response?.status, JSON.stringify(e.response?.data) || e.message);
    return "Could you please repeat that?";
  }
}

// ─── SEND: mulaw → Exotel at real-time rate ───────────────────────────────────
async function sendAudioToExotel(ws, streamSid, text) {
  console.log(`[SEND] Preparing: "${text.slice(0, 60)}" | sid=${streamSid}`);
  try {
    const mp3 = await textToSpeech(text);
    if (!mp3) { console.error("[SEND] ❌ No audio from TTS"); return; }

    const mulaw = await convertToMulaw(mp3);

    let frameCount = 0;
    for (let i = 0; i < mulaw.length; i += MULAW_FRAME_BYTES) {
      if (ws.readyState !== WebSocket.OPEN) { console.warn("[SEND] WS closed mid-send"); break; }
      ws.send(JSON.stringify({
        event:      "media",
        stream_sid: streamSid,
        media:      { payload: mulaw.slice(i, i + MULAW_FRAME_BYTES).toString("base64") },
      }));
      frameCount++;
      await new Promise(r => setTimeout(r, MULAW_FRAME_MS));
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: "done" } }));
    }

    console.log(`[SEND] ✅ ${frameCount} frames × ${MULAW_FRAME_BYTES}B = ${mulaw.length} bytes sent`);
  } catch (e) {
    console.error("[SEND] ❌", e.message);
  }
}

// ─── WebSocket handler ────────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const callId = Math.random().toString(36).substring(7);
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] ✅ New connection | callId=${callId} | IP=${ip}`);

  sessions[callId] = {
    history: [], streamSid: null,
    audioChunks: [], silenceTimer: null,
    isProcessing: false, greetingSent: false, msgCount: 0,
  };

  ws.on("message", async (msg) => {
    const session = sessions[callId];
    if (!session) return;
    session.msgCount++;

    let data;
    try { data = JSON.parse(msg.toString()); }
    catch { return; }

    if (session.msgCount <= 5) {
      console.log(`[WS] #${session.msgCount}:`, JSON.stringify(data).slice(0, 300));
    }

    switch (data.event) {
      case "connected":
        console.log("[WS] connected ✓");
        break;

      case "start": {
        const sid = data.stream_sid || data.start?.stream_sid
                 || data.streamSid  || data.start?.streamSid;
        session.streamSid = sid;
        console.log(`[WS] start ✓ | stream_sid=${sid}`);
        if (!session.greetingSent) {
          session.greetingSent = true;
          await sendAudioToExotel(ws, sid, GREETING);
          session.history.push({ role: "assistant", content: GREETING });
        }
        break;
      }

      case "media": {
        if (!session.streamSid) {
          session.streamSid = data.stream_sid || data.streamSid || `fb-${callId}`;
          console.warn("[WS] streamSid from media:", session.streamSid);
        }
        if (!session.greetingSent) {
          session.greetingSent = true;
          sendAudioToExotel(ws, session.streamSid, GREETING).then(() => {
            session.history.push({ role: "assistant", content: GREETING });
          });
          return;
        }
        if (session.isProcessing) return;

        session.audioChunks.push(Buffer.from(data.media.payload, "base64"));

        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        session.silenceTimer = setTimeout(async () => {
          if (!session.audioChunks.length || session.isProcessing) return;
          session.isProcessing = true;
          const audio = Buffer.concat(session.audioChunks);
          session.audioChunks = [];
          console.log(`[WS] Silence → processing ${audio.length} bytes`);
          if (audio.length < 3200) { console.log("[WS] Too short, skip"); session.isProcessing = false; return; }
          const text = await speechToText(audio);
          if (!text || text.trim().length < 2) { session.isProcessing = false; return; }
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

      case "mark": break;

      default:
        console.log("[WS] Unknown event:", data.event);
    }
  });

  ws.on("close", (code) => {
    console.log(`[WS] ❌ Closed | callId=${callId} | code=${code}`);
    if (sessions[callId]?.silenceTimer) clearTimeout(sessions[callId].silenceTimer);
    delete sessions[callId];
  });

  ws.on("error", e => console.error(`[WS] Error | ${callId}:`, e.message));
});

app.get("/",     (_, res) => res.json({ status: "ok", sessions: Object.keys(sessions).length }));
app.get("/ping", (_, res) => res.send("pong"));

server.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`   WebSocket: wss://exotel-ai-caller.onrender.com\n`);
});
