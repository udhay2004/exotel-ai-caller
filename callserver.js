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

// =====================
// ENV CHECK ON STARTUP
// =====================
console.log("=== ENV CHECK ===");
console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("DEEPGRAM_API_KEY:", process.env.DEEPGRAM_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_API_KEY:", process.env.ELEVENLABS_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_VOICE_ID:", process.env.ELEVENLABS_VOICE_ID ? "✅ SET" : "❌ MISSING");
console.log("ffmpegPath:", ffmpegPath ? "✅ " + ffmpegPath : "❌ NOT FOUND");
console.log("=================\n");

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
Be friendly and natural. Keep responses concise for voice conversation.
`;

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

// =====================
// CONVERT MP3 → 8kHz mulaw
// =====================
function convertToMulaw(inputBuffer) {
  return new Promise((resolve, reject) => {
    console.log("[FFMPEG] Starting conversion, input size:", inputBuffer.length);

    const ff = spawn(ffmpegPath, [
      "-y",
      "-i", "pipe:0",
      "-ar", "8000",
      "-ac", "1",
      "-acodec", "pcm_mulaw",
      "-f", "mulaw",
      "pipe:1",
    ]);

    const chunks = [];
    let stderrLog = "";

    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => { stderrLog += d.toString(); });

    ff.on("close", (code) => {
      if (chunks.length > 0) {
        const result = Buffer.concat(chunks);
        console.log("[FFMPEG] Conversion done, output size:", result.length);
        resolve(result);
      } else {
        console.error("[FFMPEG] No output produced. Exit code:", code);
        console.error("[FFMPEG] stderr:", stderrLog.slice(-500));
        reject(new Error("ffmpeg produced no output"));
      }
    });

    ff.on("error", (err) => {
      console.error("[FFMPEG] Spawn error:", err.message);
      reject(err);
    });

    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

// =====================
// DEEPGRAM STT
// =====================
async function speechToText(buffer) {
  console.log("[STT] Sending to Deepgram, buffer size:", buffer.length);
  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=en-IN&punctuate=true&model=nova-2",
      buffer,
      {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          "Content-Type": "application/octet-stream",
        },
        timeout: 10000,
      }
    );
    const transcript = res.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    const confidence = res.data?.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0;
    console.log("[STT] Transcript:", JSON.stringify(transcript), "| Confidence:", confidence);
    return transcript;
  } catch (err) {
    console.error("[STT] Deepgram error:", err.response?.status, err.response?.data || err.message);
    return "";
  }
}

// =====================
// CLAUDE AI
// =====================
async function getAIResponse(callId, text) {
  if (!sessions[callId]) sessions[callId] = { history: [], streamSid: null };

  const history = sessions[callId].history;
  history.push({ role: "user", content: text });

  console.log("[AI] Sending to Claude, history length:", history.length);

  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system: COMPANY_CONTEXT,
        messages: history,
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 15000,
      }
    );

    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log("[AI] Reply:", reply);
    return reply;
  } catch (err) {
    console.error("[AI] Claude error:", err.response?.status, err.response?.data || err.message);
    return "Could you repeat that please?";
  }
}

// =====================
// ELEVENLABS TTS
// =====================
async function textToSpeech(text) {
  console.log("[TTS] Sending to ElevenLabs:", JSON.stringify(text));
  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      },
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        responseType: "arraybuffer",
        timeout: 15000,
      }
    );
    console.log("[TTS] MP3 received, size:", res.data.byteLength);
    return Buffer.from(res.data);
  } catch (err) {
    console.error("[TTS] ElevenLabs error:", err.response?.status, err.response?.data || err.message);
    return null;
  }
}

// =====================
// SEND AUDIO TO EXOTEL
// =====================
async function sendAudioToExotel(ws, streamSid, text) {
  try {
    console.log("[SEND] Preparing audio for:", JSON.stringify(text));

    const mp3Buffer = await textToSpeech(text);
    if (!mp3Buffer) {
      console.error("[SEND] TTS returned null, aborting");
      return;
    }

    const mulawBuffer = await convertToMulaw(mp3Buffer);

    // Send in 3200-byte chunks (~200ms each at 8kHz mulaw)
    const CHUNK_SIZE = 3200;
    let chunkCount = 0;

    for (let i = 0; i < mulawBuffer.length; i += CHUNK_SIZE) {
      const chunk = mulawBuffer.slice(i, i + CHUNK_SIZE);
      if (ws.readyState === WebSocket.OPEN) {
        const payload = {
          event: "media",
          streamSid: streamSid,
          media: { payload: chunk.toString("base64") },
        };
        ws.send(JSON.stringify(payload));
        chunkCount++;
      } else {
        console.warn("[SEND] WebSocket closed mid-send");
        break;
      }
    }

    // Send mark event
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: "mark",
        streamSid: streamSid,
        mark: { name: "done" },
      }));
    }

    console.log(`[SEND] ✅ Sent ${chunkCount} chunks (${mulawBuffer.length} bytes total)`);
  } catch (err) {
    console.error("[SEND] Error:", err.message);
  }
}

// =====================
// WEBSOCKET
// =====================
wss.on("connection", (ws, req) => {
  const callId = Math.random().toString(36).substring(7);
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] ✅ New connection | callId=${callId} | IP=${ip}`);
  console.log("[WS] Headers:", JSON.stringify(req.headers, null, 2));

  sessions[callId] = {
    history: [],
    streamSid: null,
    audioChunks: [],
    silenceTimer: null,
    isProcessing: false,
    greetingSent: false,
    messageCount: 0,
  };

  // ── Fallback: if Exotel never sends 'start', send greeting on first media ──
  let startReceived = false;

  // ── Timeout: if no 'start' in 3s, use a fake streamSid and send greeting ──
  const startTimeout = setTimeout(async () => {
    if (!startReceived && sessions[callId] && !sessions[callId].greetingSent) {
      console.warn("[WS] No 'start' event received in 3s — using fallback streamSid");
      sessions[callId].streamSid = "fallback-" + callId;
      sessions[callId].greetingSent = true;
      await sendAudioToExotel(ws, sessions[callId].streamSid, GREETING);
      sessions[callId].history.push({ role: "assistant", content: GREETING });
    }
  }, 3000);

  ws.on("message", async (msg) => {
    const session = sessions[callId];
    if (!session) return;

    session.messageCount++;

    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      console.warn("[WS] Non-JSON message #" + session.messageCount + ":", msg.toString().slice(0, 100));
      return;
    }

    // Log every event (first 20 messages)
    if (session.messageCount <= 20) {
      console.log(`[WS] Event #${session.messageCount}:`, data.event || "(no event field)", 
        data.streamSid ? `| streamSid=${data.streamSid}` : "",
        data.start ? `| start=${JSON.stringify(data.start)}` : ""
      );
    }

    switch (data.event) {

      case "connected": {
        // Some Exotel versions send this first
        console.log("[WS] 'connected' event received:", JSON.stringify(data));
        break;
      }

      case "start": {
        startReceived = true;
        clearTimeout(startTimeout);

        // Exotel may put streamSid at top level OR inside data.start
        session.streamSid = data.streamSid || data.start?.streamSid || "stream-" + callId;
        console.log(`[WS] 'start' event | streamSid=${session.streamSid}`);
        console.log("[WS] start data:", JSON.stringify(data));

        if (!session.greetingSent) {
          session.greetingSent = true;
          console.log("[BOT] Sending greeting...");
          await sendAudioToExotel(ws, session.streamSid, GREETING);
          session.history.push({ role: "assistant", content: GREETING });
        }
        break;
      }

      case "media": {
        // If we somehow never got 'start', handle streamSid from media event
        if (!session.streamSid) {
          session.streamSid = data.streamSid || "stream-" + callId;
          console.log("[WS] Got streamSid from media event:", session.streamSid);
        }

        // Send greeting if not sent yet (handles Exotel configs that skip 'start')
        if (!session.greetingSent) {
          startReceived = true;
          clearTimeout(startTimeout);
          session.greetingSent = true;
          console.log("[BOT] Sending greeting (triggered by first media)...");
          // Don't await — let audio buffer and send async
          sendAudioToExotel(ws, session.streamSid, GREETING).then(() => {
            session.history.push({ role: "assistant", content: GREETING });
          });
          return;
        }

        if (session.isProcessing) return;

        const audioChunk = Buffer.from(data.media.payload, "base64");
        session.audioChunks.push(audioChunk);

        // Reset silence timer on every audio chunk
        if (session.silenceTimer) clearTimeout(session.silenceTimer);

        session.silenceTimer = setTimeout(async () => {
          if (session.audioChunks.length === 0 || session.isProcessing) return;

          session.isProcessing = true;
          const fullAudio = Buffer.concat(session.audioChunks);
          session.audioChunks = [];

          console.log(`[WS] Silence detected — processing ${fullAudio.length} bytes of audio`);

          if (fullAudio.length < 3200) {
            console.log("[WS] Audio too short (<3200 bytes), ignoring");
            session.isProcessing = false;
            return;
          }

          const transcript = await speechToText(fullAudio);
          if (!transcript || transcript.trim().length < 2) {
            console.log("[WS] Empty/short transcript, ignoring");
            session.isProcessing = false;
            return;
          }

          const reply = await getAIResponse(callId, transcript);
          await sendAudioToExotel(ws, session.streamSid, reply);

          session.isProcessing = false;
        }, 1500);

        break;
      }

      case "stop": {
        console.log(`[WS] 'stop' event | callId=${callId}`);
        break;
      }

      case "mark": {
        console.log(`[WS] 'mark' event | name=${data.mark?.name}`);
        break;
      }

      default: {
        console.log("[WS] Unknown event:", JSON.stringify(data).slice(0, 200));
      }
    }
  });

  ws.on("close", (code, reason) => {
    clearTimeout(startTimeout);
    console.log(`[WS] ❌ Closed | callId=${callId} | code=${code} | reason=${reason}`);
    if (sessions[callId]?.silenceTimer) clearTimeout(sessions[callId].silenceTimer);
    delete sessions[callId];
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error | callId=${callId} |`, err.message);
  });
});

// =====================
// HTTP
// =====================
app.get("/", (req, res) => {
  res.json({
    status: "running",
    connections: Object.keys(sessions).length,
    wsUrl: "wss://exotel-ai-caller.onrender.com",
  });
});

// Keep-alive ping to prevent Render sleeping (call this from UptimeRobot)
app.get("/ping", (req, res) => res.send("pong"));

server.listen(PORT, () => {
  console.log(`\n🚀 Server on port ${PORT}`);
  console.log(`   WSS: wss://exotel-ai-caller.onrender.com\n`);
});
