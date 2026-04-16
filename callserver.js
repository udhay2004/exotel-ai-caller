require("dotenv").config();
const express = require("express");
const axios = require("axios");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 5000;

const callSessions = {};

const COMPANY_CONTEXT = `
You are a professional telecaller from Connect Ventures Services Pvt Ltd.
You help businesses expand globally.

Rules:
- Speak only English
- Max 2 sentences
- Ask one question at a time
- No pricing, no legal advice
`;

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

// =====================
// CLAUDE
// =====================
async function getAIResponse(callId, text) {
  if (!callSessions[callId]) {
    callSessions[callId] = { history: [] };
  }

  const history = callSessions[callId].history;
  history.push({ role: "user", content: text });

  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 80,
        system: COMPANY_CONTEXT,
        messages: history
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        }
      }
    );

    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });

    return reply;
  } catch (e) {
    console.error("Claude error:", e.message);
    return "Could you repeat that?";
  }
}

// =====================
// DEEPGRAM (STT)
// =====================
async function speechToText(audioBuffer) {
  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen",
      audioBuffer,
      {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          "Content-Type": "audio/wav"
        }
      }
    );

    return res.data.results.channels[0].alternatives[0].transcript;
  } catch (e) {
    console.error("Deepgram error:", e.message);
    return "";
  }
}

// =====================
// ELEVENLABS (TTS)
// =====================
async function textToSpeech(text) {
  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        text: text,
        model_id: "eleven_monolingual_v1"
      },
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY
        },
        responseType: "arraybuffer"
      }
    );

    return Buffer.from(res.data).toString("base64");
  } catch (e) {
    console.error("ElevenLabs error:", e.message);
    return null;
  }
}

// =====================
// WEBSOCKET
// =====================
wss.on("connection", (ws) => {
  const callId = Math.random().toString(36).substring(7);

  console.log("Connected:", callId);

  ws.send(JSON.stringify({
    type: "response",
    text: GREETING
  }));

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "media") {
        const audioBase64 = data.media.payload;

        // base64 → buffer
        const audioBuffer = Buffer.from(audioBase64, "base64");

        const text = await speechToText(audioBuffer);

        if (!text) return;

        console.log("User:", text);

        const reply = await getAIResponse(callId, text);

        const audioReply = await textToSpeech(reply);

        if (!audioReply) return;

        ws.send(JSON.stringify({
          event: "media",
          media: {
            payload: audioReply
          }
        }));
      }

    } catch (e) {
      console.error("WS error:", e.message);
    }
  });

  ws.on("close", () => {
    delete callSessions[callId];
  });
});

// =====================
app.get("/", (req, res) => {
  res.send("Voice bot running");
});

server.listen(PORT, () => {
  console.log("Server running on", PORT);
});
