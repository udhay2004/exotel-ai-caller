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
// PROTOCOL: Exotel Voicebot applet
//   Inbound  (Exotel -> server): raw s16le PCM 8kHz mono, base64-encoded
//   Outbound (server -> Exotel): same format
//
// CRITICAL FINDING (from live call diagnostics):
//   Exotel delivers caller audio at extremely low amplitude (~+/-8 out of
//   +/-32767). Background noise floor = energy ~9, real speech = energy ~170.
//   Fix: lower VAD threshold to 20, amplify PCM 40x before sending to STT.
// ---------------------------------------------------------------------------

const PCM_SAMPLE_RATE       = 8000;
const PCM_BYTES_PER_SAMPLE  = 2;         // s16le = 2 bytes/sample
const FRAME_MS              = 20;
const FRAME_BYTES           = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * FRAME_MS / 1000; // 320

// VAD: observed background noise = energy 9, speech peaks = energy ~170.
// Threshold of 20 sits safely between them. Tune via ENERGY_THRESH env var.
const SILENCE_TIMEOUT_MS    = 600;   // Short: must fire before Exotel hangs up
const SILENCE_ENERGY_THRESH = parseInt(process.env.ENERGY_THRESH || "20", 10);

// Amplify incoming PCM before STT. Exotel sends ~+/-8 amplitude audio.
// Boosting 40x gives Deepgram ~+/-320 which it can transcribe reliably.
// Clamps at +/-32767. Tune via PCM_AMPLIFY env var.
const PCM_AMPLIFY           = parseFloat(process.env.PCM_AMPLIFY || "40");

const MIN_AUDIO_BYTES       = 3200;      // 100ms minimum before STT attempt

const KEEPALIVE_INTERVAL_MS      = 200;
const KEEPALIVE_FRAMES_PER_BURST = 10;

const PCM_SILENCE_BYTE = 0x00;

const COMPANY_CONTEXT =
  "You are a professional telecaller from Connect Ventures. " +
  "Keep every response to 1-2 short sentences. " +
  "Be warm, clear, and concise. Never repeat what the caller just said. " +
  "Do not use lists, bullet points, or special characters.";

const GREETING =
  "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const sessions = new Map();

// ---------------------------------------------------------------------------
// Env check
// ---------------------------------------------------------------------------
function checkEnv() {
  const required = ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY"];
  const missing  = required.filter(function(k) { return !process.env[k]; });
  if (missing.length) {
    console.error("Missing env vars:", missing.join(", "));
    process.exit(1);
  }
  if (!process.env.CAM_API_KEY && !process.env.ELEVENLABS_API_KEY) {
    console.error("No TTS provider configured.");
    process.exit(1);
  }
  var providers = [];
  if (process.env.CAM_API_KEY)        providers.push("CAMB.AI");
  if (process.env.ELEVENLABS_API_KEY) providers.push("ElevenLabs");
  console.log("Env OK | TTS:", providers.join(" -> "));
  console.log("VAD energy threshold:", SILENCE_ENERGY_THRESH);
  console.log("PCM amplify gain:", PCM_AMPLIFY);
}

// ---------------------------------------------------------------------------
// Send a 20ms PCM silence frame to Exotel
// ---------------------------------------------------------------------------
function sendPCMSilenceFrame(ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  var frame = Buffer.alloc(FRAME_BYTES, PCM_SILENCE_BYTE);
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
// Keepalive — silence bursts while waiting for TTS network round-trip
// ---------------------------------------------------------------------------
function startKeepalive(ws, streamSid) {
  var totalFrames = 0;
  var interval = setInterval(function() {
    if (!ws || ws.readyState !== WebSocket.OPEN) { clearInterval(interval); return; }
    for (var i = 0; i < KEEPALIVE_FRAMES_PER_BURST; i++) {
      sendPCMSilenceFrame(ws, streamSid);
      totalFrames++;
    }
  }, KEEPALIVE_INTERVAL_MS);

  return function stop() {
    clearInterval(interval);
    console.log("[KEEPALIVE] Stopped — " + totalFrames + " frames (~" +
      (totalFrames * FRAME_MS / 1000).toFixed(1) + "s)");
  };
}

// ---------------------------------------------------------------------------
// Stream s16le PCM from ffmpeg stdout to Exotel
// ---------------------------------------------------------------------------
function streamPCMFromFFmpeg(ffProcess, ws, streamSid, stopKeepalive) {
  return new Promise(function(resolve) {
    var remainder = Buffer.alloc(0);
    var sent      = 0;
    var kaStopped = false;

    function stopKA() {
      if (!kaStopped && stopKeepalive) { stopKeepalive(); kaStopped = true; }
    }

    ffProcess.stdout.on("data", function(chunk) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      stopKA();

      var buf    = Buffer.concat([remainder, chunk]);
      var offset = 0;
      while (offset + FRAME_BYTES <= buf.length) {
        var frame = buf.slice(offset, offset + FRAME_BYTES);
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
          return;
        }
      }
      remainder = buf.slice(offset);
    });

    ffProcess.stdout.on("end", function() {
      stopKA();
      if (remainder.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        var padLen = FRAME_BYTES - (remainder.length % FRAME_BYTES);
        var pad    = Buffer.concat([remainder, Buffer.alloc(padLen, PCM_SILENCE_BYTE)]);
        try {
          ws.send(JSON.stringify({
            event:      "media",
            stream_sid: streamSid,
            media:      { payload: pad.toString("base64") },
          }));
          sent++;
        } catch (_) {}
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            event:      "mark",
            stream_sid: streamSid,
            mark:       { name: "tts_done" },
          }));
        } catch (_) {}
      }
      var dur = (sent * FRAME_BYTES) / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE);
      console.log("[STREAM] " + sent + " frames / ~" + dur.toFixed(1) + "s sent");
      resolve();
    });

    ffProcess.stderr.on("data", function(e) {
      var m = e.toString().trim();
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
// Convert audio buffer to raw s16le PCM 8kHz mono via ffmpeg
// ---------------------------------------------------------------------------
function convertAndStream(audioBuf, ws, streamSid, fmt, stopKeepalive) {
  return new Promise(function(resolve, reject) {
    var ffArgs = [
      "-hide_banner", "-loglevel", "error",
      "-f", fmt, "-i", "pipe:0",
      "-ar", String(PCM_SAMPLE_RATE),
      "-ac", "1",
      "-f", "s16le",
      "pipe:1",
    ];
    var ff    = spawn("ffmpeg", ffArgs);
    var sendP = streamPCMFromFFmpeg(ff, ws, streamSid, stopKeepalive);
    Readable.from(audioBuf).pipe(ff.stdin);
    ff.stdin.on("error", function() {});
    sendP.then(resolve).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// TTS: CAMB.AI
// ---------------------------------------------------------------------------
async function streamTTSbyCamb(text, ws, streamSid, stopKeepalive) {
  var apiKey = process.env.CAM_API_KEY;
  if (!apiKey) throw new Error("CAM_API_KEY not set");
  var voiceId = parseInt(process.env.CAMB_VOICE_ID || "147320", 10);
  console.log("[TTS/CAMB] Fetching:", text.slice(0, 60));

  var res;
  try {
    res = await axios.post(
      "https://client.camb.ai/apis/tts-stream",
      {
        text:           text,
        language:       "en-in",
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
      console.error("[TTS/CAMB] Error:", err.message);
    }
    throw err;
  }

  var audioBuf = Buffer.from(res.data);
  console.log("[TTS/CAMB] Received " + audioBuf.length + "B");
  if (audioBuf.length < 100) throw new Error("Too small: " + audioBuf.length + "B");

  var magic = audioBuf.slice(0, 4).toString("ascii");
  var isWav = magic === "RIFF";
  var isMp3 = (audioBuf[0] === 0xFF && (audioBuf[1] & 0xE0) === 0xE0) || magic.startsWith("ID3");
  var fmt   = isWav ? "wav" : isMp3 ? "mp3" : "wav";
  console.log("[TTS/CAMB] Format:", fmt);
  await convertAndStream(audioBuf, ws, streamSid, fmt, stopKeepalive);
}

// ---------------------------------------------------------------------------
// TTS: ElevenLabs fallback
// ---------------------------------------------------------------------------
async function streamTTSbyElevenLabs(text, ws, streamSid, stopKeepalive) {
  var apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");
  var voiceId = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log("[TTS/EL] Fetching:", text.slice(0, 60));

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
      console.error("[TTS/EL] Error:", err.message);
    }
    throw err;
  }

  var audioBuf = Buffer.from(res.data);
  console.log("[TTS/EL] Received " + audioBuf.length + "B");
  await convertAndStream(audioBuf, ws, streamSid, "mp3", stopKeepalive);
}

// ---------------------------------------------------------------------------
// Master TTS
// ---------------------------------------------------------------------------
async function streamTTS(text, ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  console.log("[TTS] ->", text.slice(0, 80));

  var stopKeepalive = startKeepalive(ws, streamSid);

  var providers = [
    { name: "CAMB.AI",    fn: function() { return streamTTSbyCamb(text, ws, streamSid, stopKeepalive); } },
    { name: "ElevenLabs", fn: function() { return streamTTSbyElevenLabs(text, ws, streamSid, stopKeepalive); } },
  ];

  for (var p of providers) {
    if (p.name === "CAMB.AI"    && !process.env.CAM_API_KEY)        continue;
    if (p.name === "ElevenLabs" && !process.env.ELEVENLABS_API_KEY) continue;
    try {
      await p.fn();
      console.log("[TTS] Done via", p.name);
      return;
    } catch (err) {
      console.warn("[TTS] FAILED " + p.name + ":", err.message.slice(0, 200));
    }
  }

  stopKeepalive();
  console.error("[TTS] All providers failed");
}

// ---------------------------------------------------------------------------
// VAD: mean absolute energy of s16le PCM buffer
// ---------------------------------------------------------------------------
function pcmEnergy(buf) {
  if (!buf || buf.length < 2) return 0;
  var sum = 0;
  for (var i = 0; i + 1 < buf.length; i += 2) {
    sum += Math.abs(buf.readInt16LE(i));
  }
  return sum / (buf.length / 2);
}

// ---------------------------------------------------------------------------
// Amplify s16le PCM — Exotel sends ~+/-8 amplitude caller audio.
// We multiply every sample by `gain` (default 40x) and clamp to +/-32767
// so Deepgram receives normal speech levels it can reliably transcribe.
// ---------------------------------------------------------------------------
function amplifyPCM(buf, gain) {
  if (!gain || gain === 1) return buf;
  var out = Buffer.allocUnsafe(buf.length);
  for (var i = 0; i + 1 < buf.length; i += 2) {
    var sample    = buf.readInt16LE(i);
    var amplified = Math.round(sample * gain);
    if (amplified >  32767) amplified =  32767;
    if (amplified < -32768) amplified = -32768;
    out.writeInt16LE(amplified, i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// STT: Deepgram nova-2 (raw s16le linear16 @ 8kHz)
// ---------------------------------------------------------------------------
async function speechToText(rawBuffer) {
  // Amplify before STT — Exotel audio is extremely quiet
  var amplified  = amplifyPCM(rawBuffer, PCM_AMPLIFY);
  var preEnergy  = pcmEnergy(rawBuffer).toFixed(0);
  var postEnergy = pcmEnergy(amplified).toFixed(0);
  console.log("[STT] " + amplified.length + "B | energy raw=" +
    preEnergy + " amplified=" + postEnergy + " (gain=" + PCM_AMPLIFY + "x)");

  try {
    var res = await axios.post(
      "https://api.deepgram.com/v1/listen" +
      "?model=nova-2&smart_format=true&encoding=linear16&sample_rate=8000&language=en-IN",
      amplified,
      {
        headers: {
          Authorization:  "Token " + process.env.DEEPGRAM_API_KEY,
          "Content-Type": "audio/l16;rate=8000",
        },
        maxBodyLength: Infinity,
        timeout:       10000,
      }
    );
    var alt        = res.data && res.data.results &&
                     res.data.results.channels[0].alternatives[0];
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
          "anthropic-beta":    "messages-2023-12-15",
          "Content-Type":      "application/json",
        },
        timeout: 12000,
      }
    );
    var reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log("[AI] \"" + reply + "\"");
    return reply;
  } catch (err) {
    console.error("[AI]", err && err.response && err.response.status,
      (err.response && err.response.data) || err.message);
    return "I'm sorry, could you say that again?";
  }
}

// ---------------------------------------------------------------------------
// WebSocket handler — Exotel Voicebot protocol
// ---------------------------------------------------------------------------
wss.on("connection", function(ws, req) {
  var callId   = Math.random().toString(36).substring(2, 8);
  var clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log("\n[WS] New call | callId=" + callId + " | IP=" + clientIP);

  var session = {
    callId,
    history:          [],
    streamSid:        null,
    audioChunks:      [],
    pendingChunks:    [],    // audio received while isProcessing — never dropped
    isProcessing:     false,
    greetingSent:     false,
    silenceTimer:     null,
    wsOpen:           true,
    mediaPacketCount: 0,
    mediaByteCount:   0,
    lastMediaAt:      null,
  };
  sessions.set(callId, session);

  // ── Process one complete utterance ──────────────────────────────────────
  async function processUtterance(audio) {
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) return;
    session.isProcessing = true;
    console.log("[UTT] Processing " + audio.length + "B");
    try {
      var transcript = await speechToText(audio);
      if (transcript && transcript.trim().length > 2) {
        var reply = await getAIResponse(session.history, transcript);
        if (session.wsOpen && ws.readyState === WebSocket.OPEN) {
          await streamTTS(reply, ws, session.streamSid);
        }
      } else {
        console.log("[UTT] Empty/short transcript — skipping");
      }
    } catch (err) {
      console.error("[UTT] Error:", err.message);
    } finally {
      session.isProcessing = false;
      console.log("[UTT] Done. pending=" + session.pendingChunks.length + " pkts");

      // Drain audio buffered while we were processing
      if (session.pendingChunks.length > 0) {
        var pending = Buffer.concat(session.pendingChunks);
        session.pendingChunks = [];
        var energy = pcmEnergy(pending);
        console.log("[UTT] Draining " + pending.length + "B energy=" + energy.toFixed(0));
        if (pending.length >= MIN_AUDIO_BYTES && energy >= SILENCE_ENERGY_THRESH) {
          await processUtterance(pending);
        }
      }
    }
  }

  ws.on("message", async function(rawMsg) {
    var data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    // connected
    if (data.event === "connected") {
      console.log("[WS] connected | " + callId);
    }

    // start
    if (data.event === "start") {
      session.streamSid =
        data.stream_sid ||
        data.streamSid  ||
        (data.start && data.start.stream_sid) ||
        (data.start && data.start.streamSid) ||
        null;
      console.log("[WS] start | streamSid=" + session.streamSid);
      console.log("[WS] start payload:", JSON.stringify(data).slice(0, 500));

      if (!session.greetingSent) {
        session.greetingSent = true;
        session.history.push({ role: "assistant", content: GREETING });
        streamTTS(GREETING, ws, session.streamSid).catch(function(e) {
          console.error("[GREETING]", e.message);
        });
      }
    }

    // media — THE HOT PATH
    if (data.event === "media") {
      var rawBytes = Buffer.from(data.media.payload, "base64");
      session.mediaPacketCount++;
      session.mediaByteCount += rawBytes.length;
      session.lastMediaAt = Date.now();

      // Diagnostic logging: first 5 packets + every 50th
      if (session.mediaPacketCount <= 5 || session.mediaPacketCount % 50 === 0) {
        var hex4    = rawBytes.slice(0, 4).toString("hex");
        var pktEng  = pcmEnergy(rawBytes).toFixed(0);
        console.log("[MEDIA] pkt#" + session.mediaPacketCount +
          " " + rawBytes.length + "B hex=[" + hex4 + "]" +
          " energy=" + pktEng +
          " processing=" + session.isProcessing);
      }

      // Buffer — never drop caller audio while processing
      if (session.isProcessing) {
        session.pendingChunks.push(rawBytes);
        return;
      }

      session.audioChunks.push(rawBytes);

      // Reset silence timer on every packet
      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(function() {
        flushAudio("silence-timer");
      }, SILENCE_TIMEOUT_MS);
    }

    // stop — flush buffered audio immediately; don't wait for silence timer.
    // This is critical: Exotel ends the call before 600ms silence elapses,
    // so the timer alone is not reliable. stop event guarantees one final flush.
    if (data.event === "stop") {
      clearTimeout(session.silenceTimer);
      console.log("[WS] stop | " + callId +
        " | mediaPackets=" + session.mediaPacketCount +
        " mediaBytes=" + session.mediaByteCount +
        " lastMediaAt=" + (session.lastMediaAt ? new Date(session.lastMediaAt).toISOString() : "never"));
      if (session.mediaPacketCount === 0) {
        console.warn("[WS] WARNING: ZERO media packets from Exotel");
      }
      flushAudio("stop-event");
    }

    // flushAudio — evaluate buffered audio and run STT pipeline if speech found.
    // Called from BOTH the silence timer and the stop event.
    async function flushAudio(trigger) {
      if (session.isProcessing) {
        console.log("[VAD] flushAudio skipped (processing) trigger=" + trigger);
        return;
      }
      if (session.audioChunks.length === 0) {
        console.log("[VAD] flushAudio — no chunks trigger=" + trigger);
        return;
      }
      var audio = Buffer.concat(session.audioChunks);
      session.audioChunks = [];
      console.log("[VAD] flushAudio trigger=" + trigger + " audio=" + audio.length + "B pkts=" + session.mediaPacketCount);
      if (audio.length < MIN_AUDIO_BYTES) {
        console.log("[VAD] Too short (" + audio.length + "B) — skipped");
        return;
      }
      var energy = pcmEnergy(audio);
      console.log("[VAD] energy=" + energy.toFixed(0) + " thresh=" + SILENCE_ENERGY_THRESH);
      if (energy < SILENCE_ENERGY_THRESH) {
        console.log("[VAD] Silence — skipping");
        return;
      }
      console.log("[VAD] Speech via " + trigger + " — processing");
      await processUtterance(audio);
    }

    // mark
    if (data.event === "mark") {
      var markName = (data.mark && data.mark.name) || data.mark;
      console.log("[WS] mark:", markName);
    }
  });

  ws.on("close", function(code) {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log("[WS] closed | " + callId +
      " | code=" + code +
      " | mediaPackets=" + session.mediaPacketCount +
      " mediaBytes=" + session.mediaByteCount);
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
  res.json({
    status:           "ok",
    protocol:         "Exotel Voicebot s16le PCM",
    sessions:         sessions.size,
    uptime:           Math.floor(process.uptime()),
    tts:              tts,
    energy_threshold: SILENCE_ENERGY_THRESH,
    pcm_amplify:      PCM_AMPLIFY,
  });
});

checkEnv();
server.listen(PORT, function() { console.log("Server on port " + PORT); });
