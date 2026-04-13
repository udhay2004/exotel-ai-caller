require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 5000;

// =====================
// CONVERSATION MEMORY
// Store conversation history per call
// =====================
const callSessions = {}; // { callSid: [ {role, content}, ... ] }

// =====================
// AI CONTEXT
// =====================
const COMPANY_CONTEXT = `
You are a professional telecaller from Connect Ventures Services Pvt Ltd.
You help businesses expand globally: company formation, banking setup, tax compliance, annual maintenance, FEMA advisory.

Rules:
- Speak only English
- Keep responses SHORT — max 2 sentences
- Be confident and polite
- Goal: introduce company, ask questions, collect name, location, target country, service needed, business type, timeline
- No pricing, no legal advice, no guarantees
- If question is complex, suggest a consultation call
`;

// =====================
// AI RESPONSE (with conversation history)
// =====================
async function getAIResponse(callSid, userSpeech) {
  // Get or create session
  if (!callSessions[callSid]) {
    callSessions[callSid] = [];
  }

  const history = callSessions[callSid];

  // Build the user message
  let userMessage;
  if (!userSpeech || userSpeech.trim() === "") {
    userMessage = "Start the call. Introduce yourself briefly and ask if this is a good time to talk.";
  } else {
    userMessage = userSpeech;
  }

  // Add to history
  history.push({ role: "user", content: userMessage });

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-opus-4-20250514", // ← use your preferred model
        max_tokens: 100,
        system: COMPANY_CONTEXT,
        messages: history // Send full conversation history
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        }
      }
    );

    const aiReply = response.data.content[0].text;

    // Save AI reply to history
    history.push({ role: "assistant", content: aiReply });

    console.log(`🤖 [${callSid}] AI: ${aiReply}`);
    return aiReply;

  } catch (err) {
    console.error("❌ AI Error:", err.response?.data || err.message);
    return "I'm sorry, could you please repeat that?";
  }
}

// =====================
// HEALTH CHECK
// =====================
app.get("/", (req, res) => {
  res.json({ status: "OK", message: "Connect Ventures AI Caller Running", time: new Date() });
});

// =====================
// VOICE WEBHOOK — THIS IS WHERE THE BUGS WERE
// =====================
app.post("/voice", async (req, res) => {
  try {
    console.log("📥 Exotel Hit:", req.body);

    // Exotel sends CallSid to identify the call
    const callSid = req.body.CallSid || req.body.CallGuid || "default";
    const userSpeech = req.body.SpeechResult;

    const aiReply = await getAIResponse(callSid, userSpeech);

    res.set("Content-Type", "text/xml");

    // ✅ FIX: Say is INSIDE Gather — this stops the hang-up
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="${process.env.WEBHOOK_URL}" method="POST">
    <Say voice="en-IN" language="en-IN">${escapeXml(aiReply)}</Say>
  </Gather>
  <Redirect method="POST">${process.env.WEBHOOK_URL}</Redirect>
</Response>`);

  } catch (err) {
    console.error("❌ Voice Error:", err.message);
    res.set("Content-Type", "text/xml");
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, I am having technical difficulties. We will call you back shortly.</Say>
</Response>`);
  }
});

// =====================
// OUTBOUND CALL TRIGGER
// =====================
async function makeExotelCall(toNumber) {
  try {
    const url = `https://api.exotel.com/v1/Accounts/${process.env.EXOTEL_SID}/Calls/connect.json`;

    const response = await axios.post(url,
      new URLSearchParams({
        From: process.env.EXOTEL_NUMBER,
        To: toNumber,
        CallerId: process.env.EXOTEL_NUMBER,
        Url: process.env.WEBHOOK_URL, // ✅ Must be your public URL
        CallType: "trans",
        TimeLimit: "300", // 5 min max call length
        StatusCallback: `${process.env.WEBHOOK_URL}/status`
      }),
      {
        auth: {
          username: process.env.EXOTEL_API_KEY,
          password: process.env.EXOTEL_API_TOKEN
        },
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }
    );

    console.log("✅ Call triggered:", response.data);
    return response.data;

  } catch (err) {
    console.error("❌ Exotel Error:", err.response?.data || err.message);
    throw err;
  }
}

app.get("/start-call", async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.send("Use: /start-call?phone=91XXXXXXXXXX");
  try {
    const data = await makeExotelCall(phone);
    res.json({ success: true, call: data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// =====================
// STATUS CALLBACK (optional but useful)
// =====================
app.post("/status", (req, res) => {
  const { CallSid, Status } = req.body;
  console.log(`📊 Call ${CallSid} status: ${Status}`);
  // Clean up session when call ends
  if (["completed", "failed", "busy", "no-answer"].includes(Status)) {
    delete callSessions[CallSid];
  }
  res.sendStatus(200);
});

// =====================
// HELPER — escape XML special chars
// =====================
function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});