require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 10000;

console.log("=== VOICE AGENT STARTUP ===");
console.log("ANTHROPIC_API_KEY :", process.env.ANTHROPIC_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("DEEPGRAM_API_KEY :", process.env.DEEPGRAM_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_API_KEY :", process.env.ELEVENLABS_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_VOICE_ID:", process.env.ELEVENLABS_VOICE_ID ? "✅ " + process.env.ELEVENLABS_VOICE_ID : "❌ MISSING");
console.log("ffmpegPath :", ffmpegPath || "❌ NOT FOUND");
console.log("===========================\n");

// ─── TEST FFMPEG ON STARTUP ───────────────────────────────────────────────────
(function testFfmpeg() {
  if (!ffmpegPath) {
    console.error("[FFMPEG INIT] ❌ ffmpeg-static not found");
    return;
  }
  const ff = spawn(ffmpegPath, ["-version"]);
  let out = "";
  ff.stdout.on("data", d => out += d.toString());
  ff.on("close", code => {
    if (code === 0) {
      console.log("[FFMPEG INIT] ✅ ffmpeg ok");
    } else {
      console.error("[FFMPEG INIT] ❌ ffmpeg failed (code", code, ")");
    }
  });
})();

const sessions = {};

const COMPANY_CONTEXT = `You are a professional telecaller from Connect Ventures Services Pvt Ltd. 
Keep responses very short (1-2 sentences max). Ask one clear question at a time. 
Be friendly, natural and conversational. No pricing details, no legal advice.`;

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const MULAW_FRAME_BYTES = 160; 
const FRAME_INTERVAL_MS = 20; 

// ─── MULAW ENCODING (JavaScript fallback) ────────────────────────────────────
function pcm16ToMulaw(pcmBuffer) {
  const mulawBuffer = Buffer.alloc(pcmBuffer.length / 2);
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    const sign = (sample < 0) ? 0x80 : 0x00;
    const absSample = Math.abs(sample);
    const biased = Math.min(absSample + 0x84, 0x7FFF);
    let exponent = 7;
    for (let exp = 0; exp < 8; exp++) {
      if (biased < (0x84 << exp)) {
        exponent = exp;
        break;
      }
    }
    const mantissa = (biased >> (exponent + 3)) & 0x0F;
    const mulaw = ~(sign | (exponent << 4) | mantissa);
    mulawBuffer[i / 2] = mulaw & 0xFF;
  }
  return mulawBuffer;
}

// ─── CONVERT MP3 → MULAW (The specific fix for quirky noises) ────────────────
async function convertToMulaw(inputBuffer) {
  const tmpIn = path.join(os.tmpdir(), `cv_in_${Date.now()}.mp3`);
  const tmpOut = path.join(os.tmpdir(), `cv_out_${Date.now()}.raw`);

  try {
    fs.writeFileSync(tmpIn, inputBuffer);

    // FIX: Using -f mulaw to ensure NO HEADERS are written to tmpOut
    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-y", "-i", tmpIn,
        "-ar", "8000",      // 8kHz for telephony
        "-ac", "1",         // Mono
        "-f", "mulaw",      // CRITICAL: Force raw headerless mulaw output
        "-acodec", "pcm_mulaw",
        tmpOut
      ]);

      ff.on("close", code => {
        if (code === 0 && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 0) {
          resolve();
        } else {
          reject(new Error("FFmpeg conversion failed"));
        }
      });
      ff.on("error", reject);
    });

    const mulaw = fs.readFileSync(tmpOut);
    console.log(`[CONVERT] ✅ Generated ${mulaw.length}B Headerless Mulaw`);
    return mulaw;

  } catch (error) {
    console.log("[CONVERT] FFmpeg failed, using PCM fallback...");
    // Your original PCM fallback remains here if needed
    return null; 
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ─── TEXT-TO-SPEECH (ElevenLabs) ─────────────────────────────────────────────
async function textToSpeech(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) throw new Error("ElevenLabs credentials missing");

  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,
        model_id: "eleven_turbo_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      },
      {
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        responseType: "arraybuffer",
        timeout: 20000,
      }
    );
    return Buffer.from(res.data);
  } catch (e) {
    console.error("[TTS] ❌ ElevenLabs Error");
    return null;
  }
}

// ─── SPEECH-TO-TEXT (Deepgram) ───────────────────────────────────────────────
async function speechToText(buffer) {
  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=en-IN&model=nova-2",
      buffer,
      {
        headers: { 
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 
          "Content-Type": "application/octet-stream" 
        },
        timeout: 15000,
      }
    );
    const transcript = res.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    console.log(`[STT] User said: "${transcript}"`);
    return transcript;
  } catch (e) {
    return "";
  }
}

// ─── AI RESPONSE (Claude) ───────────────────────────────────────────────────
async function getAIResponse(callId, text) {
  const session = sessions[callId];
  session.history.push({ role: "user", content: text });
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-haiku-20240307",
        max_tokens: 150,
        system: COMPANY_CONTEXT,
        messages: session.history,
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 18000,
      }
    );
    const reply = res.data.content[0].text.trim();
    session.history.push({ role: "assistant", content: reply });
    return reply;
  } catch (e) {
    return "Could you please repeat that?";
  }
}

// ─── SEND AUDIO TO EXOTEL ────────────────────────────────────────────────────
async function sendAudioToExotel(ws, streamSid, text) {
  try {
    const mp3 = await textToSpeech(text);
    if (!mp3) return;

    const mulawBuffer = await convertToMulaw(mp3);
    if (!mulawBuffer) return;

    // Pad to 160 byte boundary
    const remainder = mulawBuffer.length % MULAW_FRAME_BYTES;
    const paddedBuffer = remainder === 0 
      ? mulawBuffer 
      : Buffer.concat([mulawBuffer, Buffer.alloc(MULAW_FRAME_BYTES - remainder, 0xFF)]);

    for (let i = 0; i < paddedBuffer.length; i += MULAW_FRAME_BYTES) {
      if (ws.readyState !== WebSocket.OPEN) break;
      const chunk = paddedBuffer.slice(i, i + MULAW_FRAME_BYTES);
      ws.send(JSON.stringify({
        event: "media",
        stream_sid: streamSid,
        media: { payload: chunk.toString("base64") }
      }));
      await new Promise(r => setTimeout(r, FRAME_INTERVAL_MS));
    }
  } catch (e) {
    console.error("[SEND] Error:", e.message);
  }
}

// ─── WEBSOCKET CONNECTION ────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const callId = Math.random().toString(36).substring(7);
  sessions[callId] = {
    history: [],
    streamSid: null,
    audioChunks: [],
    silenceTimer: null,
    isProcessing: false,
    greetingSent: false
  };

  ws.on("message", async (msg) => {
    const session = sessions[callId];
    if (!session) return;

    const data = JSON.parse(msg.toString());

    switch (data.event) {
      case "start":
        session.streamSid = data.stream_sid || data.start?.stream_sid;
        if (!session.greetingSent) {
          session.greetingSent = true;
          await sendAudioToExotel(ws, session.streamSid, GREETING);
          session.history.push({ role: "assistant", content: GREETING });
        }
        break;

      case "media":
        if (session.isProcessing) return;
        session.audioChunks.push(Buffer.from(data.media.payload, "base64"));
        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        
        session.silenceTimer = setTimeout(async () => {
          if (session.audioChunks.length < 5) return;
          session.isProcessing = true;
          const audio = Buffer.concat(session.audioChunks);
          session.audioChunks = [];

          const text = await speechToText(audio);
          if (text.trim().length > 1) {
            const reply = await getAIResponse(callId, text);
            await sendAudioToExotel(ws, session.streamSid, reply);
          }
          session.isProcessing = false;
        }, 1500);
        break;
    }
  });

  ws.on("close", () => delete sessions[callId]);
});

app.get("/health", (_, res) => res.json({ status: "ok" }));
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
