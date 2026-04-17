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
    console.error("[FFMPEG INIT] ❌ ffmpeg-static not found — audio conversion will fail");
    return;
  }
  
  const ff = spawn(ffmpegPath, ["-version"]);
  let out = "";
  ff.stdout.on("data", d => out += d.toString());
  ff.stderr.on("data", d => out += d.toString());
  ff.on("close", code => {
    if (code === 0) {
      const ver = out.match(/ffmpeg version (\S+)/);
      console.log("[FFMPEG INIT] ✅ ffmpeg ok:", ver ? ver[1] : "unknown version");
      
      // Test for mulaw encoder
      const encodersTest = spawn(ffmpegPath, ["-encoders"]);
      let encOut = "";
      encodersTest.stdout.on("data", d => encOut += d.toString());
      encodersTest.on("close", () => {
        if (encOut.includes("pcm_mulaw")) {
          console.log("[FFMPEG INIT] ✅ pcm_mulaw encoder available");
        } else {
          console.log("[FFMPEG INIT] ⚠️  pcm_mulaw encoder NOT found — will use JS fallback");
        }
      });
    } else {
      console.error("[FFMPEG INIT] ❌ ffmpeg failed (code", code, ")");
    }
  });
  ff.on("error", e => console.error("[FFMPEG INIT] ❌ spawn error:", e.message));
})();

const sessions = {};

const COMPANY_CONTEXT = `You are a professional telecaller from Connect Ventures Services Pvt Ltd. 
Keep responses very short (1-2 sentences max). Ask one clear question at a time. 
Be friendly, natural and conversational. No pricing details, no legal advice.`;

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

// Exotel uses 8kHz mulaw - 160 bytes = 20ms of audio
const MULAW_FRAME_BYTES = 160;  // 20ms at 8kHz mulaw (1 byte per sample)
const FRAME_INTERVAL_MS = 20;   // 20ms per frame

// ─── MULAW ENCODING (JavaScript fallback) ────────────────────────────────────
const MULAW_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let decoded = i ^ 0xFF;
    let sign = decoded & 0x80;
    let exponent = (decoded & 0x70) >> 4;
    let mantissa = decoded & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    if (sign) sample = -sample;
    table[i] = sample;
  }
  return table;
})();

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

// ─── CONVERT MP3 → MULAW (with PCM fallback) ─────────────────────────────────
async function convertToMulaw(inputBuffer) {
  const tmpIn = path.join(os.tmpdir(), `cv_in_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  const tmpOut = path.join(os.tmpdir(), `cv_out_${Date.now()}_${Math.random().toString(36).slice(2)}.raw`);

  try {
    fs.writeFileSync(tmpIn, inputBuffer);
    console.log(`[CONVERT] Wrote ${inputBuffer.length}B MP3 to ${tmpIn}`);

    // Try direct mulaw conversion first
    try {
      await new Promise((resolve, reject) => {
        const ff = spawn(ffmpegPath, [
          "-y", "-i", tmpIn,
          "-ar", "8000",      // 8kHz sample rate for Exotel
          "-ac", "1",          // mono
          "-f", "mulaw",       // mulaw format
          "-acodec", "pcm_mulaw",
          tmpOut
        ]);

        let stderr = "";
        ff.stderr.on("data", d => { stderr += d.toString(); });
        ff.on("close", code => {
          if (code === 0 && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 0) {
            console.log("[CONVERT] ✅ Direct mulaw conversion successful");
            resolve();
          } else {
            console.log("[CONVERT] Direct mulaw failed, trying PCM fallback...");
            reject(new Error("Direct mulaw failed"));
          }
        });
        ff.on("error", reject);
      });

      const mulaw = fs.readFileSync(tmpOut);
      console.log(`[CONVERT] ✅ Got ${mulaw.length}B mulaw (ratio: ${(mulaw.length / inputBuffer.length).toFixed(2)}x)`);
      return mulaw;

    } catch (directError) {
      // Fallback: MP3 → PCM → JS mulaw encoding
      console.log("[CONVERT] Using PCM + JS mulaw fallback...");
      
      const tmpPcm = path.join(os.tmpdir(), `cv_pcm_${Date.now()}.raw`);
      
      await new Promise((resolve, reject) => {
        const ff = spawn(ffmpegPath, [
          "-y", "-i", tmpIn,
          "-ar", "8000",
          "-ac", "1",
          "-f", "s16le",      // raw signed 16-bit PCM
          tmpPcm
        ]);

        let stderr = "";
        ff.stderr.on("data", d => { stderr += d.toString(); });
        ff.on("close", code => {
          if (code === 0 && fs.existsSync(tmpPcm)) {
            resolve();
          } else {
            console.error("[CONVERT] PCM conversion failed. stderr:", stderr.slice(-500));
            reject(new Error(`PCM conversion failed (code ${code})`));
          }
        });
        ff.on("error", reject);
      });

      const pcm = fs.readFileSync(tmpPcm);
      console.log(`[CONVERT] ✅ Got ${pcm.length}B PCM`);
      
      const mulaw = pcm16ToMulaw(pcm);
      console.log(`[CONVERT] ✅ JS-encoded to ${mulaw.length}B mulaw`);
      
      fs.unlinkSync(tmpPcm);
      return mulaw;
    }

  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ─── TEXT-TO-SPEECH (ElevenLabs + Google Fallback) ───────────────────────────
async function ttsElevenLabs(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) throw new Error("ElevenLabs credentials not set");
  
  console.log(`[TTS] ElevenLabs → "${text.slice(0, 50)}..." (voice: ${voiceId})`);

  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: "eleven_turbo_v2",
      voice_settings: { 
        stability: 0.5, 
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true 
      }
    },
    {
      headers: { 
        "xi-api-key": key, 
        "Content-Type": "application/json", 
        "Accept": "audio/mpeg" 
      },
      responseType: "arraybuffer",
      timeout: 20000,
    }
  );

  const buf = Buffer.from(res.data);
  if (buf[0] === 0x7b) { // JSON error response
    throw new Error("ElevenLabs API error: " + buf.toString("utf8").slice(0, 200));
  }
  console.log(`[TTS] ✅ ElevenLabs returned ${buf.length}B MP3`);
  return buf;
}

async function ttsGoogle(text) {
  console.log(`[TTS] Google TTS fallback for: "${text.slice(0, 50)}..."`);
  const encoded = encodeURIComponent(text);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en-IN&client=tw-ob&ttsspeed=0.9`;

  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": "https://translate.google.com/",
    },
  });

  const buf = Buffer.from(res.data);
  console.log(`[TTS] Google returned ${buf.length}B`);
  if (buf.length < 200) throw new Error(`Google TTS too small: ${buf.length}B`);
  return buf;
}

async function textToSpeech(text) {
  try {
    return await ttsElevenLabs(text);
  } catch (e) {
    console.warn("[TTS] ElevenLabs failed:", e.message, "→ trying Google TTS");
  }
  
  try {
    return await ttsGoogle(text);
  } catch (e) {
    console.error("[TTS] Google TTS also failed:", e.message);
    return null;
  }
}

// ─── SPEECH-TO-TEXT (Deepgram) ───────────────────────────────────────────────
async function speechToText(buffer) {
  console.log(`[STT] Sending ${buffer.length} bytes to Deepgram (mulaw, 8kHz)`);
  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=en-IN&punctuate=true&model=nova-2",
      buffer,
      {
        headers: { 
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 
          "Content-Type": "application/octet-stream" 
        },
        timeout: 15000,
      }
    );
    
    const alt = res.data?.results?.channels?.[0]?.alternatives?.[0];
    const transcript = alt?.transcript || "";
    const confidence = alt?.confidence || 0;
    
    console.log(`[STT] Transcript (${(confidence * 100).toFixed(0)}%): "${transcript}"`);
    return transcript;
  } catch (e) {
    console.error("[STT] Error:", e.response?.data || e.message);
    return "";
  }
}

// ─── AI RESPONSE (Anthropic Claude) ──────────────────────────────────────────
async function getAIResponse(callId, text) {
  const session = sessions[callId];
  session.history.push({ role: "user", content: text });
  
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
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
    console.log(`[AI] Reply: "${reply}"`);
    return reply;
  } catch (e) {
    console.error("[AI] Error:", e.response?.data || e.message);
    return "Could you please repeat that?";
  }
}

// ─── SEND AUDIO TO EXOTEL ────────────────────────────────────────────────────
async function sendAudioToExotel(ws, streamSid, text) {
  console.log(`[SEND] Preparing audio for: "${text.slice(0, 60)}..." | sid=${streamSid}`);
  
  try {
    const mp3 = await textToSpeech(text);
    if (!mp3) {
      console.error("[SEND] ❌ No audio from TTS");
      return;
    }

    const mulawBuffer = await convertToMulaw(mp3);

    // Pad to frame boundary if needed
    const remainder = mulawBuffer.length % MULAW_FRAME_BYTES;
    const paddedBuffer = remainder === 0 
      ? mulawBuffer 
      : Buffer.concat([mulawBuffer, Buffer.alloc(MULAW_FRAME_BYTES - remainder, 0xFF)]);

    console.log(`[SEND] Sending ${paddedBuffer.length}B mulaw in ${Math.ceil(paddedBuffer.length / MULAW_FRAME_BYTES)} frames...`);

    let frameCount = 0;
    for (let i = 0; i < paddedBuffer.length; i += MULAW_FRAME_BYTES) {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log("[SEND] ⚠️  WebSocket closed mid-send");
        break;
      }

      const chunk = paddedBuffer.slice(i, i + MULAW_FRAME_BYTES);
      
      ws.send(JSON.stringify({
        event: "media",
        stream_sid: streamSid,
        media: { payload: chunk.toString("base64") }
      }));

      frameCount++;
      
      // Send frames at proper intervals (20ms)
      await new Promise(r => setTimeout(r, FRAME_INTERVAL_MS));
    }

    // Send mark event to signal completion
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ 
        event: "mark", 
        stream_sid: streamSid, 
        mark: { name: "audio_complete" } 
      }));
    }

    console.log(`[SEND] ✅ Sent ${frameCount} frames (${paddedBuffer.length}B mulaw)`);
  } catch (e) {
    console.error("[SEND] ❌ Error:", e.message);
    console.error(e.stack);
  }
}

// ─── WEBSOCKET CONNECTION HANDLER ─────────────────────────────────────────────
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
    try { 
      data = JSON.parse(msg.toString()); 
    } catch { 
      console.log(`[WS] Non-JSON message received`);
      return; 
    }

    // Log first few messages for debugging
    if (session.msgCount <= 5) {
      console.log(`[WS] Event #${session.msgCount}:`, JSON.stringify(data).slice(0, 300));
    }

    switch (data.event) {
      case "connected":
        console.log("[WS] ✓ Connected event received");
        break;

      case "start": {
        const sid = data.stream_sid || data.start?.stream_sid || data.streamSid || data.start?.streamSid;
        session.streamSid = sid;
        console.log(`[WS] ✓ Start event | stream_sid=${sid}`);

        // Send greeting
        if (!session.greetingSent) {
          session.greetingSent = true;
          console.log("[WS] Sending greeting...");
          await sendAudioToExotel(ws, sid, GREETING);
          session.history.push({ role: "assistant", content: GREETING });
        }
        break;
      }

      case "media": {
        // Ensure we have stream_sid
        if (!session.streamSid) {
          session.streamSid = data.stream_sid || data.streamSid || `fallback-${callId}`;
        }

        // Send greeting if not sent yet
        if (!session.greetingSent) {
          session.greetingSent = true;
          sendAudioToExotel(ws, session.streamSid, GREETING).then(() => {
            session.history.push({ role: "assistant", content: GREETING });
          });
          return;
        }

        // Skip if currently processing
        if (session.isProcessing) return;

        // Accumulate audio chunks
        session.audioChunks.push(Buffer.from(data.media.payload, "base64"));

        // Reset silence timer
        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        
        session.silenceTimer = setTimeout(async () => {
          if (!session.audioChunks.length || session.isProcessing) return;

          session.isProcessing = true;
          const audio = Buffer.concat(session.audioChunks);
          session.audioChunks = [];

          console.log(`[WS] Silence detected → processing ${audio.length} bytes of audio`);

          // Minimum audio threshold (avoid processing too-short audio)
          if (audio.length < 1000) {
            console.log("[WS] Audio too short, skipping");
            session.isProcessing = false;
            return;
          }

          // Transcribe
          const text = await speechToText(audio);
          if (!text || text.trim().length < 2) {
            console.log("[WS] No meaningful transcript, skipping");
            session.isProcessing = false;
            return;
          }

          // Get AI response
          const reply = await getAIResponse(callId, text);
          
          // Send audio response
          await sendAudioToExotel(ws, session.streamSid, reply);
          
          session.isProcessing = false;
        }, 1500); // 1.5 second silence threshold

        break;
      }

      case "stop":
        console.log(`[WS] ✓ Stop event | callId=${callId}`);
        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        break;

      case "mark":
        console.log(`[WS] Mark event received:`, data.mark?.name);
        break;

      default:
        console.log("[WS] Unknown event:", data.event);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] ❌ Connection closed | callId=${callId} | code=${code} | reason=${reason || 'none'}`);
    if (sessions[callId]?.silenceTimer) {
      clearTimeout(sessions[callId].silenceTimer);
    }
    delete sessions[callId];
  });

  ws.on("error", e => {
    console.error(`[WS] Error | callId=${callId}:`, e.message);
  });
});

// ─── HTTP ROUTES ──────────────────────────────────────────────────────────────
app.get("/", (_, res) => {
  res.json({ 
    status: "ok", 
    service: "Exotel Voice Agent",
    active_sessions: Object.keys(sessions).length,
    uptime: process.uptime()
  });
});

app.get("/health", (_, res) => {
  res.json({ 
    status: "healthy",
    timestamp: new Date().toISOString(),
    sessions: Object.keys(sessions).length
  });
});

app.get("/ping", (_, res) => res.send("pong"));

// ─── START SERVER ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Voice Agent Server running on port ${PORT}`);
  console.log(`📞 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health\n`);
});
