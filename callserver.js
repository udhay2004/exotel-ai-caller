require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const { spawn } = require("child_process");

const ffmpegPath = require("ffmpeg-static"); // ✅ FIXED (IMPORTANT)

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 5000;

// =====================
// SESSION MEMORY
// =====================
const sessions = {};

// =====================
// COMPANY CONTEXT
// =====================
const COMPANY_CONTEXT = `
You are a professional telecaller from Connect Ventures Services Pvt Ltd.
Speak short, max 2 sentences.
Ask one question at a time.
No pricing, no legal advice.
`;

// =====================
// GREETING
// =====================
const GREETING =
  "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

// =====================
// CLAUDE AI
// =====================
async function getAIResponse(callId, text) {
  if (!sessions[callId]) {
    sessions[callId] = { history: [] };
  }

  const history = sessions[callId].history;
  history.push({ role: "user", content: text });

  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 80,
        system: COMPANY_CONTEXT,
        messages: history,
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });

    return reply;
  } catch (err) {
    console.error("Claude error:", err.message);
    return "Could you repeat that please?";
  }
}

// =====================
// DEEPGRAM STT
// =====================
async function speechToText(buffer) {
  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000",
      buffer,
      {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          "Content-Type": "application/octet-stream",
        },
      }
    );

    return (
      res.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || ""
    );
  } catch (err) {
    console.error("Deepgram error:", err.message);
    return "";
  }
}

// =====================
// ELEVENLABS TTS
// =====================
async function textToSpeech(text) {
  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: "eleven_monolingual_v1",
      },
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
      }
    );

    return Buffer.from(res.data).toString("base64");
  } catch (err) {
    console.error("ElevenLabs error:", err.message);
    return null;
  }
}

// =====================
// FFMPEG CONVERSION (FIXED)
// =====================
function convertToMulaw(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-y",
      "-i",
      "pipe:0",
      "-ar",
      "8000",
      "-ac",
      "1",
      "-f",
      "mulaw",
      "pipe:1",
    ]);

    let output = [];

    ff.stdout.on("data", (d) => output.push(d));
    ff.stderr.on("data", () => {});

    ff.on("close", () => {
      resolve(Buffer.concat(output));
    });

    ff.on("error", (err) => {
      console.error("FFmpeg error:", err.message);
      resolve(Buffer.alloc(0));
    });

    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

// =====================
// WEBSOCKET
// =====================
wss.on("connection", (ws) => {
  const callId = Math.random().toString(36).substring(7);

  console.log("Connected:", callId);

  sessions[callId] = { history: [] };

  ws.send(
    JSON.stringify({
      type: "text",
      text: GREETING,
    })
  );

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "media") {
        const audioBuffer = Buffer.from(data.media.payload, "base64");

        // STT
        const text = await speechToText(audioBuffer);
        if (!text) return;

        console.log("User:", text);

        // AI
        const reply = await getAIResponse(callId, text);

        // TTS
        const mp3Base64 = await textToSpeech(reply);
        if (!mp3Base64) return;

        const mp3Buffer = Buffer.from(mp3Base64, "base64");

        // CONVERT AUDIO
        const mulawBuffer = await convertToMulaw(mp3Buffer);

        ws.send(
          JSON.stringify({
            event: "media",
            media: {
              payload: mulawBuffer.toString("base64"),
            },
          })
        );
      }
    } catch (err) {
      console.error("WS error:", err.message);
    }
  });

  ws.on("close", () => {
    delete sessions[callId];
    console.log("Closed:", callId);
  });
});

// =====================
app.get("/", (req, res) => {
  res.send("AI Voice Bot Running");
});

server.listen(PORT, () => {
  console.log("Server running on", PORT);
});
