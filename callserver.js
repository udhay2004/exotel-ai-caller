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

// ---------------------------------------------------------------------------
// CRITICAL PROTOCOL NOTE — Exotel Voicebot vs Stream applet:
//
// Stream applet  → sends/expects  mulaw  8kHz base64
// Voicebot applet → sends/expects  raw s16le PCM  8kHz mono little-endian base64
//
// Previous code was sending mulaw to Voicebot → garbled noise.
// This file speaks the correct Voicebot protocol: raw PCM s16le.
//
// Outbound media message format (server → Exotel):
// {
//   "event": "media",
//   "stream_sid": "<sid>",
//   "media": { "payload": "<base64 raw s16le PCM>" }
// }
//
// To interrupt/clear audio already queued on Exotel:
// { "event": "clear", "stream_sid": "<sid>" }
//
// Chunk size rules from Exotel docs:
//   - Min: 3200 bytes (100ms of audio at 8kHz s16le = 8000*2*0.1 = 1600... actually 3200 min)
//   - Max: 100KB
//   - Must be multiple of 320 bytes (320 = 20ms frame at 8kHz s16le)
// ---------------------------------------------------------------------------

const PCM_SAMPLE_RATE    = 8000;
const PCM_BYTES_PER_SAMPLE = 2;       // s16le = 2 bytes per sample
const FRAME_MS           = 20;        // 20ms per frame
const FRAME_BYTES        = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * FRAME_MS / 1000; // 320 bytes
const SILENCE_TIMEOUT_MS = 800;
const MIN_AUDIO_BYTES    = 1600;      // catch short words like yes/no
const KEEPALIVE_INTERVAL_MS    = 200;
const KEEPALIVE_FRAMES_PER_BURST = 10; // 10 × 20ms = 200ms of silence per burst

// s16le silence is 0x00 bytes (PCM zero = silence, unlike mulaw 0xFF)
const PCM_SILENCE_BYTE = 0x00;

const SILENCE_ENERGY_THRESH = 150;   // lowered: catches short phone speech like "yes"

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
    console.error("Missing env vars:", missing.join(", "));
    process.exit(1);
  }
  if (!process.env.CAM_API_KEY && !process.env.ELEVENLABS_API_KEY) {
    console.error("No TTS provider configured.");
    process.exit(1);
  }
  const providers = [];
  if (process.env.CAM_API_KEY)        providers.push("CAMB.AI");
  if (process.env.ELEVENLABS_API_KEY) providers.push("ElevenLabs");
  console.log("Env OK | TTS:", providers.join(" -> "));
}

// ---------------------------------------------------------------------------
// Send a raw PCM silence frame to Exotel (Voicebot protocol)
// ---------------------------------------------------------------------------
function sendPCMSilenceFrame(ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const frame = Buffer.alloc(FRAME_BYTES, PCM_SILENCE_BYTE);
  try {
    ws.send(JSON.stringify({
      event:      "media",
      stream_sid: streamSid,
      media:      { payload: frame.toString("base64") },
    }));
    return true;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Continuous keepalive: send PCM silence every 200ms so Exotel doesn't
// time out while we wait for TTS to respond (takes 1-3 seconds).
// Returns a stop() function — call it when real audio starts.
// ---------------------------------------------------------------------------
function startKeepalive(ws, streamSid) {
  let totalFrames = 0;
  const interval = setInterval(function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearInterval(interval);
      return;
    }
    for (let i = 0; i < KEEPALIVE_FRAMES_PER_BURST; i++) {
      sendPCMSilenceFrame(ws, streamSid);
      totalFrames++;
    }
  }, KEEPALIVE_INTERVAL_MS);

  return function stop() {
    clearInterval(interval);
    console.log("[KEEPALIVE] Stopped after " + totalFrames + " frames (~" +
      (totalFrames * FRAME_MS / 1000).toFixed(1) + "s silence)");
  };
}

// ---------------------------------------------------------------------------
// Stream raw PCM frames from ffmpeg stdout to Exotel.
// stopKeepalive is called the moment the first real audio byte arrives.
// ---------------------------------------------------------------------------
function streamPCMFromFFmpeg(ffProcess, ws, streamSid, stopKeepalive) {
  return new Promise(function(resolve) {
    let remainder     = Buffer.alloc(0);
    let sent          = 0;
    let kaStopped     = false;

    function stopKA() {
      if (!kaStopped && stopKeepalive) { stopKeepalive(); kaStopped = true; }
    }

    ffProcess.stdout.on("data", function(chunk) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      stopKA(); // real audio is here — stop silence

      const buf = Buffer.concat([remainder, chunk]);
      let offset = 0;

      // Send in multiples of FRAME_BYTES (320 bytes = 20ms)
      while (offset + FRAME_BYTES <= buf.length) {
        const frame = buf.slice(offset, offset + FRAME_BYTES);
        offset += FRAME_BYTES;
        try {
          ws.send(JSON.stringify({
            event:      "media",
            stream_sid: streamSid,
            media:      { payload: frame.toString("base64") },
          }));
          sent++;
        } catch (e) {
          console.warn("[STREAM] send error:", e.message);
          stopKA();
          return;
        }
      }
      remainder = buf.slice(offset);
    });

    ffProcess.stdout.on("end", function() {
      stopKA();

      // Pad and send any remaining bytes
      if (remainder.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        // Pad to next multiple of FRAME_BYTES
        const padLen = FRAME_BYTES - (remainder.length % FRAME_BYTES);
        const pad = Buffer.concat([remainder, Buffer.alloc(padLen, PCM_SILENCE_BYTE)]);
        try {
          ws.send(JSON.stringify({
            event:      "media",
            stream_sid: streamSid,
            media:      { payload: pad.toString("base64") },
          }));
          sent++;
        } catch (_) {}
      }

      // Send mark so we know when Exotel finishes playing
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            event:      "mark",
            stream_sid: streamSid,
            mark:       { name: "tts_done" },
          }));
        } catch (_) {}
      }

      const dur = (sent * FRAME_BYTES) / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE);
      console.log("[STREAM] " + sent + " frames / ~" + dur.toFixed(1) + "s sent");
      resolve();
    });

    ffProcess.stderr.on("data", function(e) {
      const m = e.toString().trim();
      if (m) console.warn("[FFMPEG]", m);
    });

    ffProcess.on("error", function(err) {
      stopKA();
      console.error("[FFMPEG] spawn error:", err.message);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Convert audio buffer → raw s16le PCM at 8kHz mono → stream to Exotel
// fmt: "wav" | "mp3"
// ---------------------------------------------------------------------------
function convertAndStream(audioBuf, ws, streamSid, fmt, stopKeepalive) {
  return new Promise(function(resolve, reject) {
    // Output: raw signed 16-bit little-endian PCM, 8kHz mono
    // This is exactly what Exotel Voicebot expects
    const ffArgs = [
      "-hide_banner", "-loglevel", "error",
      "-f", fmt, "-i", "pipe:0",
      "-ar", String(PCM_SAMPLE_RATE),
      "-ac", "1",
      "-f", "s16le",   // raw PCM output — no container
      "pipe:1",
    ];
    const ff    = spawn("ffmpeg", ffArgs);
    const sendP = streamPCMFromFFmpeg(ff, ws, streamSid, stopKeepalive);
    Readable.from(audioBuf).pipe(ff.stdin);
    ff.stdin.on("error", function() {});
    sendP.then(resolve).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// TTS: CAMB.AI  — streaming pipeline for lowest latency
// CAMB.AI returns an MP3 stream. We pipe it directly into ffmpeg stdin as it
// arrives, so ffmpeg starts converting and we start sending PCM frames to
// Exotel before the full MP3 has even downloaded. This cuts ~1.5s of latency.
// ---------------------------------------------------------------------------
async function streamTTSbyCamb(text, ws, streamSid, stopKeepalive) {
  const apiKey = process.env.CAM_API_KEY;
  if (!apiKey) throw new Error("CAM_API_KEY not set");

  const voiceId = parseInt(process.env.CAMB_VOICE_ID || "147320", 10);
  console.log("[TTS/CAMB] Fetching (streaming): " + text.slice(0, 60));

  // Spawn ffmpeg first — it will start converting the moment data flows in.
  // CAMB.AI returns MP3, so input format is mp3.
  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-probesize", "32", "-analyzeduration", "0", "-f", "mp3", "-i", "pipe:0",
    "-ar", String(PCM_SAMPLE_RATE), "-ac", "1",
    "-f", "s16le", "pipe:1",
  ]);

  // Start the sender — it waits for ffmpeg stdout data
  const sendPromise = streamPCMFromFFmpeg(ff, ws, streamSid, stopKeepalive);

  // Now make the HTTP request with responseType "stream" so axios gives us
  // a Node.js Readable we can pipe directly into ffmpeg stdin
  let res;
  try {
    res = await axios.post(
      "https://client.camb.ai/apis/tts-stream",
      {
        text,
        language:       "en-in",
        voice_id:       voiceId,
        speech_model:   "mars-flash",
        voice_settings: { speaking_rate: 1.05 },
      },
      {
        headers:      { "x-api-key": apiKey, "Content-Type": "application/json" },
        responseType: "stream",   // stream directly into ffmpeg — no buffering
        timeout:      20000,
      }
    );
  } catch (err) {
    ff.kill();
    // For stream responseType, err.response.data is a stream — read it for logging
    if (err.response) {
      console.error("[TTS/CAMB] HTTP " + err.response.status);
    } else {
      console.error("[TTS/CAMB] Error: " + err.message);
    }
    throw err;
  }

  // Pipe CAMB.AI HTTP response directly into ffmpeg stdin as it arrives
  res.data.pipe(ff.stdin);
  res.data.on("error", (e) => { console.warn("[TTS/CAMB] stream err:", e.message); ff.stdin.end(); });
  res.data.on("end", () => { ff.stdin.end(); console.log("[TTS/CAMB] stream complete"); });

  await sendPromise;
}

// ---------------------------------------------------------------------------
// TTS: ElevenLabs fallback
// ---------------------------------------------------------------------------
async function streamTTSbyElevenLabs(text, ws, streamSid, stopKeepalive) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const voiceId = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log("[TTS/EL] Fetching: " + text.slice(0, 60));

  let res;
  try {
    res = await axios({
      method:       "post",
      url:          "https://api.elevenlabs.io/v1/text-to-speech/" + voiceId + "/stream",
      data: {
        text,
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
      const body = Buffer.isBuffer(err.response.data)
        ? err.response.data.toString("utf8").slice(0, 400)
        : String(err.response.data).slice(0, 400);
      console.error("[TTS/EL] HTTP " + err.response.status + ": " + body);
    } else {
      console.error("[TTS/EL] Error: " + err.message);
    }
    throw err;
  }

  const audioBuf = Buffer.from(res.data);
  console.log("[TTS/EL] Received " + audioBuf.length + "B");
  await convertAndStream(audioBuf, ws, streamSid, "mp3", stopKeepalive);
}

// ---------------------------------------------------------------------------
// Master TTS
// ---------------------------------------------------------------------------
async function streamTTS(text, ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  console.log("[TTS] -> " + text.slice(0, 80));

  const stopKeepalive = startKeepalive(ws, streamSid);

  const providers = [
    { name: "CAMB.AI",    fn: () => streamTTSbyCamb(text, ws, streamSid, stopKeepalive) },
    { name: "ElevenLabs", fn: () => streamTTSbyElevenLabs(text, ws, streamSid, stopKeepalive) },
  ];

  for (const p of providers) {
    try {
      await p.fn();
      console.log("[TTS] Done via " + p.name);
      return;
    } catch (err) {
      console.warn("[TTS] FAILED " + p.name + ": " + err.message.slice(0, 200));
    }
  }

  stopKeepalive();
  console.error("[TTS] All providers failed");
}

// ---------------------------------------------------------------------------
// VAD — PCM s16le energy (sum of absolute sample values)
// ---------------------------------------------------------------------------
function pcmEnergy(buf) {
  if (!buf || buf.length < 2) return 0;
  let sum = 0;
  // s16le: each sample is 2 bytes, little-endian signed
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i);
    sum += Math.abs(sample);
  }
  return sum / (buf.length / 2);
}

// ---------------------------------------------------------------------------
// STT: Deepgram nova-2
// Exotel Voicebot sends raw s16le PCM — Deepgram needs to know that
// ---------------------------------------------------------------------------
async function speechToText(buffer) {
  try {
    console.log("[STT] Sending " + buffer.length + "B");
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true" +
      "&encoding=linear16&sample_rate=8000&language=en-IN",
      buffer,
      {
        headers: {
          Authorization:  "Token " + process.env.DEEPGRAM_API_KEY,
          "Content-Type": "audio/l16;rate=8000",
        },
        maxBodyLength: Infinity,
        timeout:       8000,
      }
    );
    const alt        = res.data?.results?.channels[0]?.alternatives[0];
    const transcript = alt?.transcript || "";
    const confidence = alt?.confidence || 0;
    console.log("[STT] \"" + transcript + "\" (conf " + confidence.toFixed(2) + ")");
    return transcript;
  } catch (err) {
    console.error("[STT]", err?.response?.status, err.message);
    return "";
  }
}

// ---------------------------------------------------------------------------
// LLM: Claude Haiku
// ---------------------------------------------------------------------------
async function getAIResponse(history, text) {
  history.push({ role: "user", content: text });
  try {
    const res = await axios.post(
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
    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log("[AI] \"" + reply + "\"");
    return reply;
  } catch (err) {
    console.error("[AI]", err?.response?.status, err.message);
    return "I'm sorry, could you say that again?";
  }
}

// ---------------------------------------------------------------------------
// WebSocket handler — Exotel Voicebot protocol
// ---------------------------------------------------------------------------
wss.on("connection", function(ws, req) {
  const callId   = Math.random().toString(36).substring(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log("\n[WS] New call | callId=" + callId + " | IP=" + clientIP);

  const session = {
    callId,
    history:         [],
    streamSid:       null,
    audioChunks:     [],
    isProcessing:    false,
    greetingSent:    false,
    firstMediaLogged:false,
    silenceTimer:    null,
    wsOpen:          true,
  };
  sessions.set(callId, session);

  ws.on("message", async function(rawMsg) {
    let data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    if (data.event === "connected") {
      console.log("[WS] connected | " + callId);
    }

    if (data.event === "start") {
      console.log("[WS] raw start:", JSON.stringify(data).slice(0, 500));
      // Exotel Voicebot uses stream_sid (snake_case) in the start message
      session.streamSid = data.stream_sid
                       || (data.start && data.start.stream_sid)
                       || data.streamSid;
      console.log("[WS] start | streamSid=" + session.streamSid);

      if (!session.greetingSent) {
        session.greetingSent = true;
        session.history.push({ role: "assistant", content: GREETING });
        // Mark as processing during greeting so we don't try to process
        // any echo/background noise while bot is speaking
        session.isProcessing = true;
        streamTTS(GREETING, ws, session.streamSid)
          .then(function() {
            // Greeting done — clear any audio collected during playback (echo)
            // and open up for caller response
            session.audioChunks = [];
            session.isProcessing = false;
            console.log("[SESSION] Greeting done — listening for caller");
          })
          .catch(function(e) {
            session.isProcessing = false;
            console.error("[GREETING]", e.message);
          });
      }
    }

    if (data.event === "media") {
      // Log first media frame details for diagnosis
      if (!session.firstMediaLogged) {
        session.firstMediaLogged = true;
        const sample = Buffer.from(data.media.payload, "base64");
        console.log("[MEDIA] First frame: " + sample.length + "B, chunk=" +
          data.media.chunk + ", ts=" + data.media.timestamp +
          ", first4bytes=" + sample.slice(0,4).toString("hex"));
      }

      // Don't collect audio while the bot is speaking — caller audio during
      // bot speech is just echo/overlap, not a real turn.
      // But DO collect after bot finishes (isProcessing=false).
      if (session.isProcessing) return;

      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.audioChunks.push(rawBytes);

      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(async function() {
        if (session.isProcessing) return;

        const audio = Buffer.concat(session.audioChunks);
        session.audioChunks = [];

        if (audio.length < MIN_AUDIO_BYTES) {
          console.log("[VAD] Too short (" + audio.length + "B)");
          return;
        }
        const energy = pcmEnergy(audio);
        console.log("[VAD] energy=" + energy.toFixed(0) + " bytes=" + audio.length +
          " thresh=" + SILENCE_ENERGY_THRESH);
        if (energy < SILENCE_ENERGY_THRESH) {
          console.log("[VAD] Below threshold — skipping");
          return;
        }
        console.log("[VAD] Speech detected — sending to STT");
        session.isProcessing = true;

        try {
          const transcript = await speechToText(audio);
          if (transcript && transcript.trim().length > 0) {
            const reply = await getAIResponse(session.history, transcript);
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

    if (data.event === "mark") {
      console.log("[WS] mark received: " + (data.mark && data.mark.name));
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
  const tts = [];
  if (process.env.CAM_API_KEY)        tts.push("CAMB.AI");
  if (process.env.ELEVENLABS_API_KEY) tts.push("ElevenLabs");
  res.json({ status: "ok", protocol: "Exotel Voicebot (s16le PCM)", sessions: sessions.size, uptime: Math.floor(process.uptime()), tts });
});

checkEnv();
server.listen(PORT, function() { console.log("Server on port " + PORT); });
