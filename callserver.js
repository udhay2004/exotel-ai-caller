require("dotenv").config();

const express  = require("express");
const http     = require("http");
const WebSocket= require("ws");
const axios    = require("axios");
const { spawn }= require("child_process");
const ffmpegPath = require("ffmpeg-static");
const fs       = require("fs");
const path     = require("path");
const os       = require("os");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 10000;

console.log("=== ENV CHECK ===");
console.log("ANTHROPIC_API_KEY  :", process.env.ANTHROPIC_API_KEY   ? "✅ SET" : "❌ MISSING");
console.log("DEEPGRAM_API_KEY   :", process.env.DEEPGRAM_API_KEY    ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_API_KEY :", process.env.ELEVENLABS_API_KEY  ? "✅ SET" : "❌ MISSING");
console.log("ELEVENLABS_VOICE_ID:", process.env.ELEVENLABS_VOICE_ID ? "✅ " + process.env.ELEVENLABS_VOICE_ID : "❌ MISSING");
console.log("ffmpegPath         :", ffmpegPath || "❌ NOT FOUND");
console.log("=================\n");

// ─── TEST FFMPEG ON STARTUP ───────────────────────────────────────────────────
// Run a quick ffmpeg version check so we know immediately if it works
(function testFfmpeg() {
  if (!ffmpegPath) { console.error("[FFMPEG INIT] ❌ ffmpeg-static returned null — mulaw conversion will use JS fallback"); return; }
  const ff = spawn(ffmpegPath, ["-version"]);
  let out = "";
  ff.stdout.on("data", d => out += d.toString());
  ff.stderr.on("data", d => out += d.toString());
  ff.on("close", code => {
    if (code === 0) {
      const ver = out.match(/ffmpeg version (\S+)/);
      console.log("[FFMPEG INIT] ✅ ffmpeg ok:", ver ? ver[1] : "unknown version");
      // Test if mulaw encoder is available
      const ff2 = spawn(ffmpegPath, ["-encoders"]);
      let enc = "";
      ff2.stdout.on("data", d => enc += d.toString());
      ff2.stderr.on("data", d => enc += d.toString());
      ff2.on("close", () => {
        if (enc.includes("pcm_mulaw")) {
          console.log("[FFMPEG INIT] ✅ pcm_mulaw encoder available");
        } else {
          console.error("[FFMPEG INIT] ❌ pcm_mulaw encoder NOT found in this ffmpeg build — will use JS fallback");
        }
      });
    } else {
      console.error("[FFMPEG INIT] ❌ ffmpeg failed to run (code", code, ") — will use JS fallback");
    }
  });
  ff.on("error", e => console.error("[FFMPEG INIT] ❌ spawn error:", e.message, "— will use JS fallback"));
})();

const sessions = {};

const COMPANY_CONTEXT = `You are a professional telecaller from Connect Ventures Services Pvt Ltd.
Speak short, max 2 sentences. Ask one question at a time.
No pricing, no legal advice. Be friendly and natural.`;

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const MULAW_FRAME_BYTES = 160;
const MULAW_FRAME_MS    = 20;

// ─── MANUAL LINEAR PCM → MULAW ENCODER (pure JS fallback) ────────────────────
// This encodes 16-bit signed little-endian PCM samples to G.711 μ-law bytes.
// Used when ffmpeg is unavailable or broken. No external deps.
function pcm16ToMulaw(pcmBuf) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const out  = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0, j = 0; i < pcmBuf.length; i += 2, j++) {
    let sample = pcmBuf.readInt16LE(i);
    const sign = (sample < 0) ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exp = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exp > 0; exp--, expMask >>= 1) {}
    const mantissa = (sample >> (exp + 3)) & 0x0f;
    out[j] = ~(sign | (exp << 4) | mantissa) & 0xff;
  }
  return out;
}

// ─── DECODE MP3 → PCM16 via Web Audio style: use ffmpeg to raw PCM, then mulaw
// Two-step: MP3 → PCM16LE (always works) → manual mulaw encode
async function convertToMulawViaPCM(inputBuffer) {
  const tmpIn = path.join(os.tmpdir(), `cv_in_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  const tmpOut = path.join(os.tmpdir(), `cv_pcm_${Date.now()}_${Math.random().toString(36).slice(2)}.raw`);

  try {
    fs.writeFileSync(tmpIn, inputBuffer);
    console.log(`[FFMPEG-PCM] Wrote ${inputBuffer.length}B to ${tmpIn}`);

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-y",
        "-i",      tmpIn,
        "-ar",     "8000",
        "-ac",     "1",
        "-f",      "s16le",   // signed 16-bit little-endian PCM — universally supported
        "-acodec", "pcm_s16le",
        tmpOut,
      ]);

      let stderr = "";
      ff.stderr.on("data", d => { stderr += d.toString(); });
      ff.on("close", code => {
        if (code === 0 && fs.existsSync(tmpOut)) {
          resolve();
        } else {
          console.error("[FFMPEG-PCM] ❌ exit code:", code);
          // Print last 500 chars of stderr so we can see what went wrong
          console.error("[FFMPEG-PCM] stderr tail:", stderr.slice(-500));
          reject(new Error(`ffmpeg PCM conversion failed (code ${code})`));
        }
      });
      ff.on("error", e => {
        console.error("[FFMPEG-PCM] spawn error:", e.message);
        reject(e);
      });
    });

    const pcm = fs.readFileSync(tmpOut);
    console.log(`[FFMPEG-PCM] ✅ Got ${pcm.length}B PCM (ratio: ${(pcm.length / inputBuffer.length).toFixed(2)}x vs mp3)`);

    if (pcm.length < 800) throw new Error(`PCM output too small: ${pcm.length}B`);

    // Manual encode PCM → mulaw (no ffmpeg mulaw encoder needed)
    const mulaw = pcm16ToMulaw(pcm);
    console.log(`[MULAW-JS] ✅ Encoded ${pcm.length}B PCM → ${mulaw.length}B mulaw`);
    return mulaw;

  } finally {
    try { fs.unlinkSync(tmpIn);  } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ─── FFMPEG DIRECT MULAW (original approach, kept as primary attempt) ─────────
async function convertToMulawDirect(inputBuffer) {
  const tmpIn  = path.join(os.tmpdir(), `cv_in_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  const tmpOut = path.join(os.tmpdir(), `cv_ul_${Date.now()}_${Math.random().toString(36).slice(2)}.ul`);

  try {
    fs.writeFileSync(tmpIn, inputBuffer);

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegPath, [
        "-y", "-i", tmpIn,
        "-ar", "8000", "-ac", "1",
        "-acodec", "pcm_mulaw",
        "-f", "mulaw",
        tmpOut,
      ]);
      let stderr = "";
      ff.stderr.on("data", d => { stderr += d.toString(); });
      ff.on("close", code => {
        if (code === 0 && fs.existsSync(tmpOut)) resolve();
        else reject(new Error(`ffmpeg direct mulaw failed (code ${code})\n${stderr.slice(-300)}`));
      });
      ff.on("error", reject);
    });

    const out = fs.readFileSync(tmpOut);
    if (out.length === inputBuffer.length) throw new Error("Output size equals input — not converted");
    if (out.length < 800) throw new Error(`Output too small: ${out.length}B`);
    console.log(`[FFMPEG-DIRECT] ✅ ${inputBuffer.length}B → ${out.length}B mulaw (${(out.length/inputBuffer.length).toFixed(2)}x)`);
    return out;

  } finally {
    try { fs.unlinkSync(tmpIn);  } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ─── MAIN CONVERTER: tries direct mulaw, falls back to PCM+JS encode ──────────
async function convertToMulaw(inputBuffer) {
  if (!ffmpegPath) {
    console.error("[CONVERT] ❌ No ffmpeg — cannot decode MP3 without it");
    throw new Error("ffmpeg not available");
  }

  // Try direct mulaw conversion first
  try {
    return await convertToMulawDirect(inputBuffer);
  } catch (e) {
    console.warn("[CONVERT] Direct mulaw failed:", e.message, "→ trying PCM+JS path");
  }

  // Fallback: ffmpeg to raw PCM, then manual JS mulaw encode
  return await convertToMulawViaPCM(inputBuffer);
}

// ─── TTS: ElevenLabs ─────────────────────────────────────────────────────────
async function ttsElevenLabs(text) {
  const key     = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) throw new Error("ElevenLabs credentials not set");

  console.log("[TTS] ElevenLabs → voice:", voiceId);
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: "eleven_turbo_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.0, use_speaker_boost: true },
    },
    {
      headers: {
        "xi-api-key":   key,
        "Content-Type": "application/json",
        "Accept":       "audio/mpeg",
      },
      responseType: "arraybuffer",
      timeout: 20000,
    }
  );

  const buf = Buffer.from(res.data);
  if (buf[0] === 0x7b) throw new Error("ElevenLabs API error: " + buf.toString("utf8").slice(0, 200));

  const isMP3 = (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)
             || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
  if (!isMP3) throw new Error(`Unexpected ElevenLabs format: ${buf.slice(0,4).toString("hex")}`);

  console.log(`[TTS] ✅ ElevenLabs MP3: ${buf.length} bytes`);
  return buf;
}

// ─── TTS: Google Translate fallback ──────────────────────────────────────────
async function ttsGoogle(text) {
  console.log("[TTS] Google TTS fallback...");
  const encoded = encodeURIComponent(text);
  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=en-IN&client=tw-ob&ttsspeed=0.9`;

  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      "Referer":    "https://translate.google.com/",
    },
  });

  const buf = Buffer.from(res.data);
  console.log(`[TTS] Google: ${buf.length}B, header: ${buf.slice(0,8).toString("hex")}`);
  if (buf.length < 200) throw new Error(`Google TTS too small: ${buf.length}B`);
  return buf;
}

// ─── TTS orchestrator ─────────────────────────────────────────────────────────
async function textToSpeech(text) {
  try { return await ttsElevenLabs(text); }
  catch (e) { console.warn("[TTS] ElevenLabs failed:", e.message, "→ Google TTS"); }

  try { return await ttsGoogle(text); }
  catch (e) { console.error("[TTS] Google TTS failed:", e.message); return null; }
}

// ─── STT: Deepgram ────────────────────────────────────────────────────────────
async function speechToText(buffer) {
  console.log("[STT] Sending", buffer.length, "bytes to Deepgram");
  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=en-IN&punctuate=true&model=nova-2",
      buffer,
      {
        headers: {
          Authorization:  `Token ${process.env.DEEPGRAM_API_KEY}`,
          "Content-Type": "application/octet-stream",
        },
        timeout: 15000,
      }
    );
    const alt        = res.data?.results?.channels?.[0]?.alternatives?.[0];
    const transcript = alt?.transcript || "";
    const confidence = alt?.confidence || 0;
    console.log("[STT] Transcript:", JSON.stringify(transcript), "| confidence:", confidence.toFixed(2));
    return transcript;
  } catch (e) {
    console.error("[STT] Error:", e.response?.status, JSON.stringify(e.response?.data) || e.message);
    return "";
  }
}

// ─── AI: Claude ───────────────────────────────────────────────────────────────
async function getAIResponse(callId, text) {
  const session = sessions[callId];
  session.history.push({ role: "user", content: text });
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system:     COMPANY_CONTEXT,
        messages:   session.history,
      },
      {
        headers: {
          "x-api-key":         process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type":      "application/json",
        },
        timeout: 18000,
      }
    );
    const reply = res.data.content[0].text.trim();
    session.history.push({ role: "assistant", content: reply });
    console.log("[AI] Reply:", reply);
    return reply;
  } catch (e) {
    console.error("[AI] Error:", e.response?.status, JSON.stringify(e.response?.data) || e.message);
    return "Could you please repeat that?";
  }
}

// ─── SEND: mulaw → Exotel at real-time rate ───────────────────────────────────
async function sendAudioToExotel(ws, streamSid, text) {
  console.log(`[SEND] Preparing: "${text.slice(0, 60)}" | sid=${streamSid}`);
  try {
    const mp3 = await textToSpeech(text);
    if (!mp3) { console.error("[SEND] ❌ No audio from TTS"); return; }

    const mulaw = await convertToMulaw(mp3);

    let frameCount = 0;
    for (let i = 0; i < mulaw.length; i += MULAW_FRAME_BYTES) {
      if (ws.readyState !== WebSocket.OPEN) { console.warn("[SEND] WS closed mid-send"); break; }
      ws.send(JSON.stringify({
        event:      "media",
        stream_sid: streamSid,
        media:      { payload: mulaw.slice(i, i + MULAW_FRAME_BYTES).toString("base64") },
      }));
      frameCount++;
      await new Promise(r => setTimeout(r, MULAW_FRAME_MS));
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: "done" } }));
    }

    console.log(`[SEND] ✅ ${frameCount} frames × ${MULAW_FRAME_BYTES}B = ${mulaw.length}B sent`);
  } catch (e) {
    console.error("[SEND] ❌", e.message);
  }
}

// ─── WebSocket handler ────────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const callId = Math.random().toString(36).substring(7);
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] ✅ New connection | callId=${callId} | IP=${ip}`);

  sessions[callId] = {
    history: [], streamSid: null,
    audioChunks: [], silenceTimer: null,
    isProcessing: false, greetingSent: false, msgCount: 0,
  };

  ws.on("message", async (msg) => {
    const session = sessions[callId];
    if (!session) return;
    session.msgCount++;

    let data;
    try { data = JSON.parse(msg.toString()); }
    catch { return; }

    if (session.msgCount <= 5) {
      console.log(`[WS] Event #${session.msgCount} raw:`, JSON.stringify(data).slice(0, 300));
    }

    switch (data.event) {
      case "connected":
        console.log("[WS] connected ✓");
        break;

      case "start": {
        const sid = data.stream_sid || data.start?.stream_sid
                 || data.streamSid  || data.start?.streamSid;
        session.streamSid = sid;
        const from = data.start?.from || data.from || "?";
        const to   = data.start?.to   || data.to   || "?";
        console.log(`[WS] start ✓ | stream_sid=${sid} | from=${from} → to=${to}`);
        if (!session.greetingSent) {
          session.greetingSent = true;
          await sendAudioToExotel(ws, sid, GREETING);
          session.history.push({ role: "assistant", content: GREETING });
        }
        break;
      }

      case "media": {
        if (!session.streamSid) {
          session.streamSid = data.stream_sid || data.streamSid || `fb-${callId}`;
          console.warn("[WS] streamSid from media:", session.streamSid);
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
          console.log(`[WS] Silence → processing ${audio.length} bytes`);
          if (audio.length < 3200) { console.log("[WS] Too short, skip"); session.isProcessing = false; return; }
          const text = await speechToText(audio);
          if (!text || text.trim().length < 2) { session.isProcessing = false; return; }
          const reply = await getAIResponse(callId, text);
          await sendAudioToExotel(ws, session.streamSid, reply);
          session.isProcessing = false;
        }, 1500);
        break;
      }

      case "stop":
        console.log(`[WS] stop | callId=${callId}`);
        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        break;

      case "mark": break;

      default:
        console.log("[WS] Unknown event:", data.event);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] ❌ Closed | callId=${callId} | code=${code} | reason=${reason}`);
    if (sessions[callId]?.silenceTimer) clearTimeout(sessions[callId].silenceTimer);
    delete sessions[callId];
  });

  ws.on("error", e => console.error(`[WS] Error | ${callId}:`, e.message));
});

app.get("/",     (_, res) => res.json({ status: "ok", sessions: Object.keys(sessions).length }));
app.get("/ping", (_, res) => res.send("pong"));

server.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`   WebSocket: wss://exotel-ai-caller.onrender.com\n`);
});
