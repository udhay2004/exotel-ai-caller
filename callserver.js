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

console.log("=== VOICE AGENT STARTUP ===");
console.log("ANTHROPIC_API_KEY :", process.env.ANTHROPIC_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("DEEPGRAM_API_KEY :", process.env.DEEPGRAM_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_API_KEY :", process.env.ELEVENLABS_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("ffmpegPath :", ffmpegPath || "❌ NOT FOUND");
console.log("===========================\n");

const sessions = {};

const COMPANY_CONTEXT = `You are a professional telecaller from Connect Ventures Services Pvt Ltd. 
Keep responses very short (1-2 sentences max). Ask one clear question at a time. 
Be friendly, natural and conversational. No pricing details, no legal advice.`;

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const MULAW_FRAME_BYTES = 160;  // 20ms of audio
const FRAME_INTERVAL_MS = 20;   // Standard telephony interval

// ─── IMPROVED AUDIO CONVERSION (Piped to avoid headers) ──────────────────────
async function convertToMulaw(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-i", "pipe:0",      // Read from stdin
      "-f", "mulaw",       // Force raw mulaw (no headers)
      "-ar", "8000",       // 8kHz sample rate
      "-ac", "1",          // Mono
      "-acodec", "pcm_mulaw",
      "pipe:1"             // Output to stdout
    ]);

    let chunks = [];
    ff.stdout.on("data", (chunk) => chunks.push(chunk));
    ff.stderr.on("data", (data) => { /* ffmpeg logs debug if needed */ });
    
    ff.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`FFmpeg failed with code ${code}`));
      }
    });

    ff.on("error", reject);
    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

// ─── TEXT-TO-SPEECH (ElevenLabs) ─────────────────────────────────────────────
async function textToSpeech(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  
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
        timeout: 15000,
      }
    );
    return Buffer.from(res.data);
  } catch (e) {
    console.error("[TTS] ❌ ElevenLabs Error:", e.message);
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
        timeout: 10000,
      }
    );
    return res.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  } catch (e) {
    console.error("[STT] ❌ Deepgram Error:", e.message);
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
        timeout: 10000,
      }
    );
    const reply = res.data.content[0].text.trim();
    session.history.push({ role: "assistant", content: reply });
    return reply;
  } catch (e) {
    return "I'm sorry, can you say that again?";
  }
}

// ─── SEND AUDIO TO EXOTEL ────────────────────────────────────────────────────
async function sendAudioToExotel(ws, streamSid, text) {
  console.log(`[SEND] Bot: ${text}`);
  try {
    const mp3 = await textToSpeech(text);
    if (!mp3) return;

    const mulawBuffer = await convertToMulaw(mp3);

    // Precise 20ms frame streaming
    for (let i = 0; i < mulawBuffer.length; i += MULAW_FRAME_BYTES) {
      if (ws.readyState !== WebSocket.OPEN) break;

      const chunk = mulawBuffer.slice(i, i + MULAW_FRAME_BYTES);
      ws.send(JSON.stringify({
        event: "media",
        stream_sid: streamSid,
        media: { payload: chunk.toString("base64") }
      }));

      await new Promise(r => setTimeout(r, FRAME_INTERVAL_MS));
    }

    ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: "done" } }));
  } catch (e) {
    console.error("[SEND] ❌ Streaming Error:", e.message);
  }
}

// ─── WEBSOCKET LOGIC ─────────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  const callId = Math.random().toString(36).substring(7);
  console.log(`[WS] New Call: ${callId}`);

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

    if (data.event === "start") {
      session.streamSid = data.stream_sid || data.start?.stream_sid;
      console.log(`[WS] Stream SID: ${session.streamSid}`);
      
      // Send greeting immediately
      if (!session.greetingSent) {
        session.greetingSent = true;
        session.isProcessing = true; // Lock to prevent user interruption during greeting
        await sendAudioToExotel(ws, session.streamSid, GREETING);
        session.history.push({ role: "assistant", content: GREETING });
        session.isProcessing = false;
      }
    }

    if (data.event === "media" && !session.isProcessing) {
      session.audioChunks.push(Buffer.from(data.media.payload, "base64"));

      if (session.silenceTimer) clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(async () => {
        if (session.audioChunks.length < 10 || session.isProcessing) return;

        session.isProcessing = true;
        const audio = Buffer.concat(session.audioChunks);
        session.audioChunks = [];

        console.log(`[WS] Processing user speech...`);
        const transcript = await speechToText(audio);
        
        if (transcript.trim().length > 1) {
          const reply = await getAIResponse(callId, transcript);
          await sendAudioToExotel(ws, session.streamSid, reply);
        }

        session.isProcessing = false;
      }, 1200); // 1.2s silence detection
    }
  });

  ws.on("close", () => delete sessions[callId]);
});

app.get("/health", (_, res) => res.send("Voice Bridge Online"));

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
