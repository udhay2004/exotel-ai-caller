require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 5000;

// =====================
// CONVERSATION MEMORY
// =====================
const callSessions = {};

// =====================
// AI CONTEXT
// =====================
const COMPANY_CONTEXT = `
You are a professional telecaller from Connect Ventures Services Pvt Ltd.
You help businesses expand globally: company formation, banking setup, tax compliance, annual maintenance, FEMA advisory.

Rules:
- Speak only English
- Keep responses SHORT — max 2 sentences only, never more
- Be confident and polite
- Goal: ask questions one at a time, collect name, location, target country, service needed, business type, timeline
- No pricing, no legal advice, no guarantees
- If question is complex, suggest a consultation call
- Never use special characters, asterisks, bullet points or symbols in your response — only plain spoken English
`;

// Static opening greeting — no Claude API call needed, responds instantly
const GREETING = "Hello, I am calling from Connect Ventures Services Private Limited. We help businesses expand globally with company formation, banking, and compliance. Is this a good time to talk?";

// =====================
// AI RESPONSE WITH TIMEOUT PROTECTION
// =====================
async function getAIResponse(callSid, userSpeech) {
  if (!callSessions[callSid]) {
    callSessions[callSid] = [];
  }

  const history = callSessions[callSid];
  history.push({ role: "user", content: userSpeech });

  try {
    // ✅ 8 second timeout — Exotel waits max ~10s, so we must respond before that
    const response = await Promise.race([
      axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-haiku-4-5-20251001", // ✅ Haiku is much faster than Opus for voice
          max_tokens: 80,
          system: COMPANY_CONTEXT,
          messages: history
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
      .replace(/[*_#&<>]/g, "") // strip any symbols that break XML or sound bad
      .trim();

    history.push({ role: "assistant", content: aiReply });

    console.log(`🤖 [${callSid}] AI: ${aiReply}`);
    return aiReply;

  } catch (err) {
    console.error("❌ AI Error:", err.response?.data || err.message);
    // Fallback response if Claude is slow or fails — call does NOT hang up
    return "Could you please tell me a bit about your business and which country you are looking to expand into?";
  }
}

// =====================
// HEALTH CHECK
// =====================
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "Connect Ventures AI Caller Running",
    time: new Date(),
    webhook: process.env.WEBHOOK_URL || "NOT SET — ADD TO RENDER ENV"
  });
});

// =====================
// VOICE WEBHOOK
// =====================
app.post("/voice", async (req, res) => {
  try {
    console.log("📥 Exotel Hit:", JSON.stringify(req.body));

    const callSid = req.body.CallSid || req.body.CallGuid || req.body.From || "default";
    const userSpeech = req.body.SpeechResult;
    const webhookUrl = process.env.WEBHOOK_URL;

    let replyText;

    if (!userSpeech || userSpeech.trim() === "") {
      // ✅ FIRST HIT — respond instantly with static greeting, no Claude call
      replyText = GREETING;
      console.log(`📞 [${callSid}] First hit — sending static greeting`);
    } else {
      // ✅ SUBSEQUENT HITS — user has spoken, now ask Claude
      console.log(`🗣️ [${callSid}] User said: ${userSpeech}`);
      replyText = await getAIResponse(callSid, userSpeech);
    }

    res.set("Content-Type", "text/xml");
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="6" speechTimeout="auto" action="${webhookUrl}" method="POST">
    <Say voice="en-IN" language="en-IN">${escapeXml(replyText)}</Say>
  </Gather>
  <Redirect method="POST">${webhookUrl}</Redirect>
</Response>`);

  } catch (err) {
    console.error("❌ Voice Error:", err.message);
    res.set("Content-Type", "text/xml");
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="6" speechTimeout="auto" action="${process.env.WEBHOOK_URL}" method="POST">
    <Say voice="en-IN" language="en-IN">I am sorry, could you please repeat that?</Say>
  </Gather>
  <Redirect method="POST">${process.env.WEBHOOK_URL}</Redirect>
</Response>`);
  }
});

// =====================
// OUTBOUND CALL TRIGGER
// =====================
async function makeExotelCall(toNumber) {
  const url = `https://api.exotel.com/v1/Accounts/${process.env.EXOTEL_SID}/Calls/connect.json`;

  const response = await axios.post(url,
    new URLSearchParams({
      From: process.env.EXOTEL_NUMBER,
      To: toNumber,
      CallerId: process.env.EXOTEL_NUMBER,
      Url: process.env.WEBHOOK_URL,
      CallType: "trans",
      TimeLimit: "300",
      StatusCallback: `${process.env.WEBHOOK_URL.replace("/voice", "")}/status`
    }),
    {
      auth: {
        username: process.env.EXOTEL_API_KEY,
        password: process.env.EXOTEL_API_TOKEN
      },
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }
  );

  console.log("✅ Call triggered to:", toNumber, response.data);
  return response.data;
}

app.get("/start-call", async (req, res) => {
  const phone = req.query.phone;
  if (!phone) {
    return res.send("Usage: /start-call?phone=+91XXXXXXXXXX");
  }
  try {
    const data = await makeExotelCall(phone);
    res.json({ success: true, message: `Calling ${phone}`, call: data });
  } catch (err) {
    console.error("❌ Call Error:", err.response?.data || err.message);
    res.json({ success: false, error: err.response?.data || err.message });
  }
});

// =====================
// STATUS CALLBACK
// =====================
app.post("/status", (req, res) => {
  const { CallSid, Status, To } = req.body;
  console.log(`📊 Call to ${To} — Status: ${Status} — SID: ${CallSid}`);
  if (["completed", "failed", "busy", "no-answer"].includes(Status)) {
    delete callSessions[CallSid];
    console.log(`🧹 Session cleared for ${CallSid}`);
  }
  res.sendStatus(200);
});

// =====================
// HELPER — escape XML characters
// =====================
function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 Webhook URL: ${process.env.WEBHOOK_URL || "⚠️ NOT SET"}`);
  console.log(`📞 Exotel Number: ${process.env.EXOTEL_NUMBER || "⚠️ NOT SET"}`);
  console.log(`🤖 Claude Key: ${process.env.ANTHROPIC_API_KEY ? "✅ SET" : "⚠️ NOT SET"}`);
});
