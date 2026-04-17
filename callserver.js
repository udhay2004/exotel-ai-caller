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
Be friendly and natural. Keep responses concise for voice conversation.
`;

// =====================
// GREETING
// =====================
const GREETING =
  "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

// =====================
// CONVERT MP3 → 8kHz mulaw (what Exotel expects)
// =====================
function convertToMulaw(inputBuffer) {
  return new Promise((resolve, reject) => {
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
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", () => {}); // suppress ffmpeg logs
    ff.on("close", (code) => {
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error("ffmpeg produced no output, code: " + code));
      }
    });
    ff.on("error", reject);

    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

// =====================
// DEEPGRAM STT
// =====================
async function speechToText(buffer) {
  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=en-IN&punctuate=true",
      buffer,
      {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          "Content-Type": "application/octet-stream",
        },
      }
    );
    const transcript =
      res.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    console.log("[STT] Transcript:", transcript);
    return transcript;
  } catch (err) {
    console.error("[STT] Deepgram error:", err.response?.data || err.message);
    return "";
  }
}

// =====================
// CLAUDE AI
// =====================
async function getAIResponse(callId, text) {
  if (!sessions[callId]) {
    sessions[callId] = { history: [], streamSid: null };
  }

  const history = sessions[callId].history;
  history.push({ role: "user", content: text });

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
      }
    );

    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log("[AI] Reply:", reply);
    return reply;
  } catch (err) {
    console.error("[AI] Claude error:", err.response?.data || err.message);
    return "Could you repeat that please?";
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
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      },
      {
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        responseType: "arraybuffer",
      }
    );

    console.log("[TTS] Audio received, size:", res.data.byteLength);
    return Buffer.from(res.data);
  } catch (err) {
    console.error("[TTS] ElevenLabs error:", err.response?.data || err.message);
    return null;
  }
}

// =====================
// SEND AUDIO TO EXOTEL via WS
// =====================
async function sendAudioToExotel(ws, streamSid, text) {
  try {
    // 1. TTS → MP3 buffer
    const mp3Buffer = await textToSpeech(text);
    if (!mp3Buffer) {
      console.error("[SEND] TTS failed, skipping");
      return;
    }

    // 2. Convert MP3 → 8kHz mulaw
    const mulawBuffer = await convertToMulaw(mp3Buffer);
    console.log("[SEND] mulaw buffer size:", mulawBuffer.length);

    // 3. Send in chunks of 320 bytes (20ms of audio at 8kHz)
    // Exotel can handle larger payloads too, but chunking is safer
    const CHUNK_SIZE = 3200; // ~200ms chunks
    for (let i = 0; i < mulawBuffer.length; i += CHUNK_SIZE) {
      const chunk = mulawBuffer.slice(i, i + CHUNK_SIZE);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid: streamSid,
            media: {
              payload: chunk.toString("base64"),
            },
          })
        );
      }
    }

    // 4. Send a mark event so we know playback finished
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          event: "mark",
          streamSid: streamSid,
          mark: { name: "response_done" },
        })
      );
    }

    console.log("[SEND] Audio sent to Exotel");
  } catch (err) {
    console.error("[SEND] Error sending audio:", err.message);
  }
}

// =====================
// WEBSOCKET HANDLER
// =====================
wss.on("connection", (ws, req) => {
  const callId = Math.random().toString(36).substring(7);
  console.log(`\n[WS] New connection: ${callId} from ${req.socket.remoteAddress}`);

  // Session: store history, streamSid, and audio buffer for accumulating chunks
  sessions[callId] = {
    history: [],
    streamSid: null,
    audioChunks: [],
    silenceTimer: null,
    isProcessing: false,
    greetingSent: false,
  };

  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      console.warn("[WS] Non-JSON message received");
      return;
    }

    const session = sessions[callId];
    if (!session) return;

    switch (data.event) {
      // ── Exotel sends this first with metadata ──
      case "start": {
        session.streamSid = data.streamSid || data.start?.streamSid;
        console.log(`[WS] Stream started. streamSid: ${session.streamSid}`);

        // Send greeting after stream starts
        if (!session.greetingSent) {
          session.greetingSent = true;
          console.log("[BOT] Sending greeting...");
          await sendAudioToExotel(ws, session.streamSid, GREETING);
          // Add greeting to history so AI has context
          session.history.push({
            role: "assistant",
            content: GREETING,
          });
        }
        break;
      }

      // ── Incoming audio from caller ──
      case "media": {
        if (session.isProcessing) return; // Don't process while bot is speaking

        const audioChunk = Buffer.from(data.media.payload, "base64");
        session.audioChunks.push(audioChunk);

        // Use a silence timer — wait 1.5s of no new audio before processing
        if (session.silenceTimer) clearTimeout(session.silenceTimer);

        session.silenceTimer = setTimeout(async () => {
          if (session.audioChunks.length === 0) return;
          if (session.isProcessing) return;

          session.isProcessing = true;

          // Combine all audio chunks
          const fullAudio = Buffer.concat(session.audioChunks);
          session.audioChunks = [];

          console.log(`[WS] Processing audio buffer: ${fullAudio.length} bytes`);

          // Minimum audio threshold (ignore very short noise)
          if (fullAudio.length < 1600) {
            console.log("[WS] Audio too short, ignoring");
            session.isProcessing = false;
            return;
          }

          // STT
          const transcript = await speechToText(fullAudio);
          if (!transcript || transcript.trim().length < 2) {
            console.log("[WS] Empty transcript, ignoring");
            session.isProcessing = false;
            return;
          }

          console.log(`[USER] ${transcript}`);

          // AI
          const reply = await getAIResponse(callId, transcript);

          // TTS + Send
          await sendAudioToExotel(ws, session.streamSid, reply);

          session.isProcessing = false;
        }, 1500); // 1.5 second silence = end of user speech

        break;
      }

      case "stop": {
        console.log(`[WS] Stream stopped: ${callId}`);
        break;
      }

      case "mark": {
        // Exotel confirms our audio finished playing
        console.log(`[WS] Mark received:`, data.mark?.name);
        break;
      }

      default:
        console.log("[WS] Unknown event:", data.event);
    }
  });

  ws.on("close", () => {
    console.log(`[WS] Connection closed: ${callId}`);
    if (sessions[callId]?.silenceTimer) {
      clearTimeout(sessions[callId].silenceTimer);
    }
    delete sessions[callId];
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error on ${callId}:`, err.message);
  });
});

// =====================
// HTTP ROUTES
// =====================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Connect Ventures AI Voice Bot is running",
    websocket: "wss://exotel-ai-caller.onrender.com",
  });
});

// Exotel webhook — returns TwiML-like response pointing to your WS
// Configure this URL in your Exotel app's "Applet" settings
app.post("/voice", express.urlencoded({ extended: false }), (req, res) => {
  console.log("[HTTP] Incoming call webhook:", req.body);
  // Exotel uses a different format — you configure WS URL in their dashboard
  // This endpoint just confirms the call
  res.status(200).send("OK");
});

// =====================
server.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   WebSocket: wss://exotel-ai-caller.onrender.com`);
  console.log(`   Health:    https://exotel-ai-caller.onrender.com/\n`);
});
