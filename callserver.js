require("dotenv").config();
const express = require("express");
const axios = require("axios");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 5000;

// =====================
// MEMORY STORE
// =====================
const callSessions = {};

// =====================
// COMPANY CONTEXT (UNCHANGED - YOUR STRONG PART)
// =====================
const COMPANY_CONTEXT = `
You are a professional telecaller from Connect Ventures Services Pvt Ltd.
You help businesses expand globally: company formation, banking setup, tax compliance, annual maintenance, FEMA advisory.

Rules:
- Speak only English
- Keep responses SHORT — max 2 sentences only
- Be confident and polite
- Ask one question at a time
- Collect: name, location, target country, service needed, business type, timeline
- No pricing, no legal advice, no guarantees
- If complex, suggest consultation
- No special characters
`;

// =====================
// GREETING
// =====================
const GREETING = "Hello, I am calling from Connect Ventures. We help businesses expand globally. Is this a good time to talk?";

// =====================
// AI FUNCTION (SAME BUT OPTIMIZED)
// =====================
async function getAIResponse(callId, userSpeech) {
  if (!callSessions[callId]) {
    callSessions[callId] = {
      history: [],
      lead: {}
    };
  }

  const session = callSessions[callId];
  session.history.push({ role: "user", content: userSpeech });

  try {
    const response = await Promise.race([
      axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 80,
          system: COMPANY_CONTEXT,
          messages: session.history
        },
        {
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
          }
        }
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Claude timeout")), 8000)
      )
    ]);

    const aiReply = response.data.content[0].text
      .replace(/[*_#&<>]/g, "")
      .trim();

    session.history.push({ role: "assistant", content: aiReply });

    console.log(`🤖 [${callId}] AI: ${aiReply}`);

    return aiReply;

  } catch (err) {
    console.error("❌ AI Error:", err.message);
    return "Could you tell me which country you want to expand into?";
  }
}

// =====================
// WEBSOCKET HANDLER
// =====================
wss.on("connection", (ws, req) => {
  const callId = Math.random().toString(36).substring(7);

  console.log(`🔌 New WS connection: ${callId}`);

  // INIT SESSION
  callSessions[callId] = {
    history: [],
    lead: {}
  };

  // SEND GREETING
  ws.send(JSON.stringify({
    type: "response",
    text: GREETING
  }));

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      console.log(`📥 [${callId}] Incoming:`, data);

      // =====================
      // HANDLE TEXT INPUT
      // =====================
      if (data.type === "input") {

        const userSpeech = data.text;

        if (!userSpeech || userSpeech.trim() === "") {
          ws.send(JSON.stringify({
            type: "response",
            text: "Could you please repeat that?"
          }));
          return;
        }

        console.log(`🗣️ [${callId}] User: ${userSpeech}`);

        const aiReply = await getAIResponse(callId, userSpeech);

        ws.send(JSON.stringify({
          type: "response",
          text: aiReply
        }));
      }

      // =====================
      // OPTIONAL: HANDLE AUDIO (ADVANCED)
      // =====================
      if (data.type === "audio") {
        console.log("🎧 Audio received (not implemented yet)");
        // Later: integrate STT here
      }

    } catch (err) {
      console.error("❌ WS Error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log(`❌ Connection closed: ${callId}`);

    // CLEANUP
    delete callSessions[callId];
  });
});

// =====================
// HEALTH CHECK
// =====================
app.get("/", (req, res) => {
  res.send("🚀 WebSocket AI Voice Bot Running");
});

// =====================
// START SERVER
// =====================
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 WS URL: wss://your-render-url`);
});
