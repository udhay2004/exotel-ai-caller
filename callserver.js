require("dotenv").config();
const express      = require("express");
const http         = require("http");
const WebSocket    = require("ws");
const axios        = require("axios");
const { spawn }    = require("child_process");
const { Readable } = require("stream");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 10000;

const MULAW_FRAME_BYTES     = 160;
const SILENCE_TIMEOUT_MS    = 1200;
const MIN_AUDIO_BYTES       = 3200;
const MULAW_SILENCE_BYTE    = 0xFF;
const SILENCE_ENERGY_THRESH = 5;

const COMPANY_CONTEXT =
  "You are a professional telecaller from Connect Ventures. " +
  "Keep every response to 1-2 short sentences. " +
  "Be warm, clear, and concise. Never repeat what the caller just said. " +
  "Do not use lists, bullet points, or special characters.";

const GREETING =
  "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const sessions = new Map();

// ---------------------------------------------------------------------------
// Startup check
// ---------------------------------------------------------------------------
function checkEnv() {
  const required = ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY"];
  const missing  = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing required env vars:", missing.join(", "));
    process.exit(1);
  }
  const cambKey = process.env.CAM_API_KEY;
  const elKey   = process.env.ELEVENLABS_API_KEY;
  if (!cambKey && !elKey) {
    console.error("No TTS provider! Add CAM_API_KEY or ELEVENLABS_API_KEY.");
    process.exit(1);
  }
  const providers = [];
  if (cambKey) providers.push("CAMB.AI");
  if (elKey)   providers.push("ElevenLabs");
  console.log("Env OK | TTS cascade:", providers.join(" -> "));
}

// ---------------------------------------------------------------------------
// Keep-alive: send silent frames so Exotel does not hang up during TTS fetch.
// Exotel outbound media events require camelCase `streamSid`.
// ---------------------------------------------------------------------------
function sendKeepAlive(ws, streamSid, frameCount) {
  frameCount = frameCount || 5;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const silenceFrame = Buffer.alloc(MULAW_FRAME_BYTES, MULAW_SILENCE_BYTE);
  const payload      = silenceFrame.toString("base64");
  for (let i = 0; i < frameCount; i++) {
    try {
      ws.send(JSON.stringify({ event: "media", streamSid: streamSid, media: { payload: payload } }));
    } catch (_) {}
  }
  console.log("[KEEPALIVE] Sent " + frameCount + " silent frames");
}

// ---------------------------------------------------------------------------
// Stream mulaw frames to Exotel as ffmpeg produces them.
// ---------------------------------------------------------------------------
function streamMulawFromFFmpeg(ffProcess, ws, streamSid) {
  return new Promise(function(resolve) {
    var remainder = Buffer.alloc(0);
    var sent      = 0;

    ffProcess.stdout.on("data", function(chunk) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      var buf    = Buffer.concat([remainder, chunk]);
      var offset = 0;
      while (offset + MULAW_FRAME_BYTES <= buf.length) {
        var frame = buf.slice(offset, offset + MULAW_FRAME_BYTES);
        offset += MULAW_FRAME_BYTES;
        try {
          ws.send(JSON.stringify({
            event:     "media",
            streamSid: streamSid,
            media:     { payload: frame.toString("base64") },
          }));
          sent++;
        } catch (e) {
          console.warn("[STREAM] send failed:", e.message);
          return;
        }
      }
      remainder = buf.slice(offset);
    });

    ffProcess.stdout.on("end", function() {
      if (remainder.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        var pad = Buffer.alloc(MULAW_FRAME_BYTES, MULAW_SILENCE_BYTE);
        remainder.copy(pad);
        try {
          ws.send(JSON.stringify({
            event:     "media",
            streamSid: streamSid,
            media:     { payload: pad.toString("base64") },
          }));
          sent++;
        } catch (_) {}
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ event: "mark", streamSid: streamSid, mark: { name: "tts_done" } }));
        } catch (_) {}
      }
      var dur = (sent * MULAW_FRAME_BYTES) / 8000;
      console.log("[STREAM] " + sent + " frames / ~" + dur.toFixed(1) + "s sent");
      resolve();
    });

    ffProcess.stderr.on("data", function(e) {
      var m = e.toString().trim();
      if (m) console.warn("[FFMPEG]", m);
    });

    ffProcess.on("error", function(err) {
      console.error("[FFMPEG] spawn error:", err.message);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Convert an audio buffer to 8kHz mulaw and stream to Exotel.
// fmt: "wav" | "mp3"   (auto-detected from magic bytes before calling)
// ---------------------------------------------------------------------------
function convertAndStream(audioBuf, ws, streamSid, fmt) {
  return new Promise(function(resolve, reject) {
    var ffArgs = [
      "-hide_banner", "-loglevel", "error",
      "-f", fmt, "-i", "pipe:0",
      "-ar", "8000", "-ac", "1",
      "-acodec", "pcm_mulaw", "-f", "mulaw", "pipe:1",
    ];
    var ff    = spawn("ffmpeg", ffArgs);
    var sendP = streamMulawFromFFmpeg(ff, ws, streamSid);
    Readable.from(audioBuf).pipe(ff.stdin);
    ff.stdin.on("error", function() {});
    sendP.then(resolve).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// TTS PROVIDER 1: CAMB.AI
//
// KEY FIX — responseType changed from "stream" to "arraybuffer":
//   With responseType "stream", axios does NOT throw on 4xx — it returns the
//   raw http.IncomingMessage (a TLSSocket). When the catch block tried to
//   JSON.stringify(err.response.data), it hit the TLSSocket circular reference
//   and crashed: "Converting circular structure to JSON --> TLSSocket".
//   With "arraybuffer" we get a plain Buffer, axios throws correctly on 4xx,
//   and we can safely log the error body from CAMB.AI.
//
// language: "english" — CAMB.AI mars-flash uses full English word, not ISO code.
//   "en" and "en-in" both return 422.
//
// Removed inference_options — not valid for mars-flash, causes 422.
//
// Auto-detect WAV vs MP3 from magic bytes so the code is format-agnostic.
// ---------------------------------------------------------------------------
async function streamTTSbyCamb(text, ws, streamSid) {
  var apiKey = process.env.CAM_API_KEY;
  if (!apiKey) throw new Error("CAM_API_KEY not set");

  var voiceId = parseInt(process.env.CAMB_VOICE_ID || "147320", 10);
  console.log("[TTS/CAMB] voice=" + voiceId + " | " + text.slice(0, 60));

  var res;
  try {
    res = await axios.post(
      "https://client.camb.ai/apis/tts-stream",
      {
        text:           text,
        language:       "english",
        voice_id:       voiceId,
        speech_model:   "mars-flash",
        voice_settings: { speaking_rate: 1.05 },
      },
      {
        headers:      { "x-api-key": apiKey, "Content-Type": "application/json" },
        responseType: "arraybuffer",
        timeout:      20000,
      }
    );
  } catch (err) {
    if (err.response) {
      var body = Buffer.isBuffer(err.response.data)
        ? err.response.data.toString("utf8").slice(0, 400)
        : String(err.response.data).slice(0, 400);
      console.error("[TTS/CAMB] HTTP " + err.response.status + ": " + body);
    } else {
      console.error("[TTS/CAMB] Error: " + err.message);
    }
    throw err;
  }

  var audioBuf = Buffer.from(res.data);
  console.log("[TTS/CAMB] Received " + audioBuf.length + "B");

  if (audioBuf.length < 100) {
    throw new Error("CAMB.AI returned too-small buffer: " + audioBuf.length + "B");
  }

  // Detect format from magic bytes
  var magic = audioBuf.slice(0, 4).toString("ascii");
  var isWav = magic === "RIFF";
  var isMp3 = (audioBuf[0] === 0xFF && (audioBuf[1] & 0xE0) === 0xE0) || magic.startsWith("ID3");
  var fmt   = isWav ? "wav" : isMp3 ? "mp3" : "wav";
  console.log("[TTS/CAMB] Detected format: " + fmt + " (magic bytes: " + magic + ")");

  await convertAndStream(audioBuf, ws, streamSid, fmt);
}

// ---------------------------------------------------------------------------
// TTS PROVIDER 2: ElevenLabs
//
// Uses mp3_44100_128 — works on ALL ElevenLabs plan tiers including free.
// If you still get 401, your ELEVENLABS_API_KEY in Render env vars is
// wrong or expired. Go to Render dashboard -> Environment -> check the value.
// ---------------------------------------------------------------------------
async function streamTTSbyElevenLabs(text, ws, streamSid) {
  var apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  var voiceId = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log("[TTS/EL] voice=" + voiceId + " | " + text.slice(0, 60));

  var res;
  try {
    res = await axios({
      method:       "post",
      url:          "https://api.elevenlabs.io/v1/text-to-speech/" + voiceId + "/stream",
      data: {
        text:           text,
        model_id:       "eleven_turbo_v2",
        output_format:  "mp3_44100_128",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
      },
      headers:      { "xi-api-key": apiKey, "Content-Type": "application/json" },
      responseType: "arraybuffer",
      timeout:      15000,
    });
  } catch (err) {
    if (err.response) {
      var body = Buffer.isBuffer(err.response.data)
        ? err.response.data.toString("utf8").slice(0, 400)
        : String(err.response.data).slice(0, 400);
      console.error("[TTS/EL] HTTP " + err.response.status + ": " + body);
    } else {
      console.error("[TTS/EL] Error: " + err.message);
    }
    throw err;
  }

  var audioBuf = Buffer.from(res.data);
  console.log("[TTS/EL] Received " + audioBuf.length + "B mp3");
  await convertAndStream(audioBuf, ws, streamSid, "mp3");
}

// ---------------------------------------------------------------------------
// Master TTS: try providers in order, send silence if all fail
// ---------------------------------------------------------------------------
async function streamTTS(text, ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  console.log("[TTS] -> " + text.slice(0, 80));

  sendKeepAlive(ws, streamSid, 5);

  var providers = [
    { name: "CAMB.AI",    fn: function() { return streamTTSbyCamb(text, ws, streamSid); } },
    { name: "ElevenLabs", fn: function() { return streamTTSbyElevenLabs(text, ws, streamSid); } },
  ];

  for (var i = 0; i < providers.length; i++) {
    var p = providers[i];
    try {
      await p.fn();
      console.log("[TTS] Done via " + p.name);
      return;
    } catch (err) {
      console.warn("[TTS] FAILED " + p.name + ": " + err.message.slice(0, 200));
    }
  }

  console.error("[TTS] All providers failed — sending silence");
  var buf    = Buffer.alloc(16000, MULAW_SILENCE_BYTE);
  var offset = 0;
  while (offset + MULAW_FRAME_BYTES <= buf.length && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        event:     "media",
        streamSid: streamSid,
        media:     { payload: buf.slice(offset, offset + MULAW_FRAME_BYTES).toString("base64") },
      }));
    } catch (_) { break; }
    offset += MULAW_FRAME_BYTES;
  }
}

// ---------------------------------------------------------------------------
// VAD
// ---------------------------------------------------------------------------
function mulawEnergy(buf) {
  if (!buf || !buf.length) return 0;
  var s = 0;
  for (var i = 0; i < buf.length; i++) s += Math.abs(buf[i] - MULAW_SILENCE_BYTE);
  return s / buf.length;
}

// ---------------------------------------------------------------------------
// STT: Deepgram nova-2
// ---------------------------------------------------------------------------
async function speechToText(buffer) {
  try {
    console.log("[STT] Sending " + buffer.length + "B");
    var res = await axios.post(
      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&encoding=mulaw&sample_rate=8000&language=en-IN",
      buffer,
      {
        headers: {
          Authorization:  "Token " + process.env.DEEPGRAM_API_KEY,
          "Content-Type": "audio/mulaw",
        },
        maxBodyLength: Infinity,
        timeout:       8000,
      }
    );
    var alt        = res.data && res.data.results && res.data.results.channels[0] && res.data.results.channels[0].alternatives[0];
    var transcript = (alt && alt.transcript) || "";
    var confidence = (alt && alt.confidence) || 0;
    console.log("[STT] \"" + transcript + "\" (conf " + confidence.toFixed(2) + ")");
    return transcript;
  } catch (err) {
    console.error("[STT]", err && err.response && err.response.status, err.message);
    return "";
  }
}

// ---------------------------------------------------------------------------
// LLM: Claude Haiku
// ---------------------------------------------------------------------------
async function getAIResponse(history, text) {
  history.push({ role: "user", content: text });
  try {
    var res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 120,
        system:     COMPANY_CONTEXT,
        messages:   history,
      },
      {
        headers: {
          "x-api-key":         process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 10000,
      }
    );
    var reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log("[AI] \"" + reply + "\"");
    return reply;
  } catch (err) {
    console.error("[AI]", err && err.response && err.response.status, err.message);
    return "I'm sorry, could you say that again?";
  }
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------
wss.on("connection", function(ws, req) {
  var callId   = Math.random().toString(36).substring(2, 8);
  var clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log("\n[WS] New call | callId=" + callId + " | IP=" + clientIP);

  var session = {
    callId:       callId,
    history:      [],
    streamSid:    null,
    audioChunks:  [],
    isProcessing: false,
    greetingSent: false,
    silenceTimer: null,
    wsOpen:       true,
  };
  sessions.set(callId, session);

  ws.on("message", async function(rawMsg) {
    var data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    if (data.event === "connected") {
      console.log("[WS] connected | " + callId);
    }

    if (data.event === "start") {
      session.streamSid = (data.start && (data.start.stream_sid || data.start.streamSid))
                       || data.streamSid
                       || data.stream_sid;
      console.log("[WS] start | streamSid=" + session.streamSid);

      if (!session.greetingSent) {
        session.greetingSent = true;
        session.history.push({ role: "assistant", content: GREETING });
        streamTTS(GREETING, ws, session.streamSid).catch(function(e) {
          console.error("[GREETING]", e.message);
        });
      }
    }

    if (data.event === "media") {
      if (session.isProcessing) return;

      var rawBytes = Buffer.from(data.media.payload, "base64");
      session.audioChunks.push(rawBytes);

      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(async function() {
        if (session.isProcessing) return;

        var audio = Buffer.concat(session.audioChunks);
        session.audioChunks = [];

        if (audio.length < MIN_AUDIO_BYTES) {
          console.log("[VAD] Too short (" + audio.length + "B)");
          return;
        }
        var energy = mulawEnergy(audio);
        if (energy < SILENCE_ENERGY_THRESH) {
          console.log("[VAD] Silence (energy=" + energy.toFixed(2) + ")");
          return;
        }
        console.log("[VAD] Speech | energy=" + energy.toFixed(2) + " | " + audio.length + "B");
        session.isProcessing = true;

        try {
          var transcript = await speechToText(audio);
          if (transcript && transcript.trim().length > 2) {
            var reply = await getAIResponse(session.history, transcript);
            if (session.wsOpen && ws.readyState === WebSocket.OPEN) {
              await streamTTS(reply, ws, session.streamSid);
            }
          } else {
            console.log("[VAD] Empty transcript — skipping");
          }
        } catch (err) {
          console.error("[SESSION]", err.message);
        } finally {
          session.isProcessing = false;
        }
      }, SILENCE_TIMEOUT_MS);
    }

    if (data.event === "stop") {
      console.log("[WS] stop | " + callId);
      clearTimeout(session.silenceTimer);
    }
  });

  ws.on("close", function(code) {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log("[WS] closed | " + callId + " | code=" + code);
    sessions.delete(callId);
  });

  ws.on("error", function(err) {
    session.wsOpen = false;
    console.error("[WS] error | " + callId + ":", err.message);
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/", function(req, res) {
  var tts = [];
  if (process.env.CAM_API_KEY)        tts.push("CAMB.AI");
  if (process.env.ELEVENLABS_API_KEY) tts.push("ElevenLabs");
  res.json({ status: "ok", sessions: sessions.size, uptime: Math.floor(process.uptime()), tts: tts });
});

checkEnv();
server.listen(PORT, function() { console.log("Server on port " + PORT); });
