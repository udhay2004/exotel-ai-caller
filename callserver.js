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

console.log("=== ENV CHECK ===");
console.log("ANTHROPIC_API_KEY :", process.env.ANTHROPIC_API_KEY  ? "✅ SET" : "❌ MISSING");
console.log("DEEPGRAM_API_KEY  :", process.env.DEEPGRAM_API_KEY   ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_API_KEY:", process.env.ELEVENLABS_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_VOICE_ID:", process.env.ELEVENLABS_VOICE_ID ? "✅ " + process.env.ELEVENLABS_VOICE_ID : "❌ MISSING");
console.log("ffmpegPath        :", ffmpegPath || "❌ NOT FOUND");
console.log("=================\n");

const sessions = {};

const COMPANY_CONTEXT = `
You are a professional telecaller from Connect Ventures Services Pvt Ltd.
Speak short, max 2 sentences. Ask one question at a time.
No pricing, no legal advice. Be friendly and natural.
`;

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

function convertToMulaw(inputBuffer) {
  return new Promise((resolve, reject) => {
    console.log("[FFMPEG] Input size:", inputBuffer.length, "bytes");
    const ff = spawn(ffmpegPath, [
      "-y", "-i", "pipe:0",
      "-ar", "8000", "-ac", "1",
      "-acodec", "pcm_mulaw", "-f", "mulaw",
      "pipe:1",
    ]);
    const chunks = [];
    let stderr = "";
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => { stderr += d.toString(); });
    ff.on("close", (code) => {
      if (chunks.length > 0) {
        const out = Buffer.concat(chunks);
        console.log("[FFMPEG] Output size:", out.length, "bytes");
        resolve(out);
      } else {
        console.error("[FFMPEG] No output! code:", code, "\n", stderr.slice(-400));
        reject(new Error("ffmpeg no output"));
      }
    });
    ff.on("error", reject);
    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

async function textToSpeech(text) {
  // Try ElevenLabs first
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
    try {
      console.log("[TTS] Trying ElevenLabs...");
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
      const buf = Buffer.from(res.data);
      // If response starts with '{' it's a JSON error, not audio
      if (buf[0] === 0x7b) {
        console.error("[TTS] ElevenLabs error JSON:", buf.toString("utf8").slice(0, 200));
        throw new Error("ElevenLabs returned error");
      }
      console.log("[TTS] ✅ ElevenLabs OK, size:", buf.length);
      return buf;
    } catch (err) {
      console.warn("[TTS] ElevenLabs failed:", err.message, "→ falling back to Google TTS");
    }
  }

  // Fallback: Google TTS (unofficial but free)
  try {
    console.log("[TTS] Trying Google TTS fallback...");
    const encoded = encodeURIComponent(text);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en-IN&client=tw-ob`;
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://translate.google.com/",
      },
    });
    const buf = Buffer.from(res.data);
    console.log("[TTS] ✅ Google TTS OK, size:", buf.length);
    return buf;
  } catch (err) {
    console.error("[TTS] Google TTS failed:", err.message);
    return null;
  }
}

async function speechToText(buffer) {
  console.log("[STT] Sending", buffer.length, "bytes to Deepgram");
  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=en-IN&punctuate=true&model=nova-2",
      buffer,
      {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          "Content-Type": "application/octet-stream",
        },
        timeout: 12000,
      }
    );
    const transcript = res.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    const confidence = res.data?.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0;
    console.log("[STT] Transcript:", JSON.stringify(transcript), "| confidence:", confidence);
    return transcript;
  } catch (err) {
    console.error("[STT] Deepgram error:", err.response?.status, err.response?.data || err.message);
    return "";
  }
}

async function getAIResponse(callId, text) {
  if (!sessions[callId]) sessions[callId] = { history: [] };
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
        timeout: 15000,
      }
    );
    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log("[AI] Reply:", reply);
    return reply;
  } catch (err) {
    console.error("[AI] Claude error:", err.response?.status, err.response?.data || err.message);
    return "Could you please repeat that?";
  }
}

async function sendAudioToExotel(ws, streamSid, text) {
  console.log(`[SEND] Preparing: "${text.slice(0, 60)}" | stream_sid: ${streamSid}`);
  try {
    const mp3 = await textToSpeech(text);
    if (!mp3) { console.error("[SEND] No audio from TTS"); return; }

    const mulaw = await convertToMulaw(mp3);

    const CHUNK = 3200;
    let count = 0;
    for (let i = 0; i < mulaw.length; i += CHUNK) {
      if (ws.readyState !== WebSocket.OPEN) { console.warn("[SEND] WS closed mid-send"); break; }
      ws.send(JSON.stringify({
        event: "media",
        stream_sid: streamSid,
        media: { payload: mulaw.slice(i, i + CHUNK).toString("base64") },
      }));
      count++;
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: "mark",
        stream_sid: streamSid,
        mark: { name: "done" },
      }));
    }

    console.log(`[SEND] ✅ Done — ${count} chunks, ${mulaw.length} bytes total`);
  } catch (err) {
    console.error("[SEND] Error:", err.message);
  }
}

wss.on("connection", (ws, req) => {
  const callId = Math.random().toString(36).substring(7);
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] ✅ New connection | callId=${callId} | IP=${ip}`);

  sessions[callId] = {
    history: [],
    streamSid: null,
    audioChunks: [],
    silenceTimer: null,
    isProcessing: false,
    greetingSent: false,
    msgCount: 0,
  };

  ws.on("message", async (msg) => {
    const session = sessions[callId];
    if (!session) return;
    session.msgCount++;

    let data;
    try { data = JSON.parse(msg.toString()); }
    catch { console.warn("[WS] Non-JSON:", msg.toString().slice(0, 80)); return; }

    if (session.msgCount <= 3) {
      console.log(`[WS] Event #${session.msgCount}:`, JSON.stringify(data).slice(0, 400));
    }

    switch (data.event) {

      case "connected":
        console.log("[WS] connected ✓");
        break;

      case "start": {
        // ✅ KEY FIX: Exotel sends stream_sid (underscore), not streamSid (camelCase)
        const sid = data.stream_sid
          || data.start?.stream_sid
          || data.streamSid
          || data.start?.streamSid;
        session.streamSid = sid;
        console.log(`[WS] start ✓ | stream_sid=${sid} | from=${data.start?.from} → to=${data.start?.to}`);

        if (!session.greetingSent) {
          session.greetingSent = true;
          await sendAudioToExotel(ws, session.streamSid, GREETING);
          session.history.push({ role: "assistant", content: GREETING });
        }
        break;
      }

      case "media": {
        if (!session.streamSid) {
          session.streamSid = data.stream_sid || data.streamSid || "fallback-" + callId;
          console.warn("[WS] streamSid from media event:", session.streamSid);
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
          console.log(`[WS] Silence → ${audio.length} bytes`);

          if (audio.length < 3200) {
            console.log("[WS] Too short, skip");
            session.isProcessing = false;
            return;
          }

          const text = await speechToText(audio);
          if (!text || text.trim().length < 2) {
            console.log("[WS] Empty transcript, skip");
            session.isProcessing = false;
            return;
          }

          const reply = await getAIResponse(callId, text);
          await sendAudioToExotel(ws, session.streamSid, reply);
          session.isProcessing = false;
        }, 1500);

        break;
      }

      case "stop":
        console.log(`[WS] stop | callId=${callId}`);
        break;

      case "mark":
        break;

      default:
        console.log("[WS] Unknown event:", data.event);
    }
  });

  ws.on("close", (code) => {
    console.log(`[WS] ❌ Closed | callId=${callId} | code=${code}`);
    if (sessions[callId]?.silenceTimer) clearTimeout(sessions[callId].silenceTimer);
    delete sessions[callId];
  });

  ws.on("error", (err) => console.error(`[WS] Error | ${callId}:`, err.message));
});

app.get("/", (req, res) => res.json({ status: "ok", sessions: Object.keys(sessions).length }));
app.get("/ping", (req, res) => res.send("pong"));

server.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}\n`);
});
