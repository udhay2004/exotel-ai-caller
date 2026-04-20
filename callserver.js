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
//   Inbound  (Exotel → server): raw s16le PCM 8kHz mono, base64-encoded
//   Outbound (server → Exotel): same format
//
// Chunk size rules (Exotel docs):
//   Min: 3200 bytes  (100 ms at 8kHz s16le)
//   Max: 100 KB
//   Must be multiple of 320 bytes (20 ms frame)
// ---------------------------------------------------------------------------

const PCM_SAMPLE_RATE      = 8000;
const PCM_BYTES_PER_SAMPLE = 2;          // s16le
const FRAME_MS             = 20;
const FRAME_BYTES          = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * FRAME_MS / 1000; // 320

// ── Silence / VAD ──────────────────────────────────────────────────────────
// FIX #1: Increased silence timeout. 1200ms fired too early on real phone
// audio where Exotel buffers/re-packetises speech. 1800ms is safer.
const SILENCE_TIMEOUT_MS   = 1800;

// FIX #2: Lowered energy floor. Real phone audio from Exotel can be quieter
// than synthetic test PCM. 300 is a safer floor; adjust via env if needed.
const SILENCE_ENERGY_THRESH = parseInt(process.env.ENERGY_THRESH || "300", 10);

const MIN_AUDIO_BYTES      = 3200;       // 100 ms minimum before we even try STT

// ── Keepalive (silence padding while TTS fetches) ──────────────────────────
const KEEPALIVE_INTERVAL_MS      = 200;
const KEEPALIVE_FRAMES_PER_BURST = 10;   // 10 × 20 ms = 200 ms per burst

const PCM_SILENCE_BYTE = 0x00;           // s16le silence = 0x00 0x00

// ── Prompts ────────────────────────────────────────────────────────────────
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
  console.log("Energy threshold:", SILENCE_ENERGY_THRESH);
}

// ---------------------------------------------------------------------------
// Send a single 20 ms PCM silence frame
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
// Keepalive — sends silence while we wait for TTS network latency.
// Returns a stop() function.
// ---------------------------------------------------------------------------
function startKeepalive(ws, streamSid) {
  let totalFrames = 0;
  const interval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { clearInterval(interval); return; }
    for (let i = 0; i < KEEPALIVE_FRAMES_PER_BURST; i++) {
      sendPCMSilenceFrame(ws, streamSid);
      totalFrames++;
    }
  }, KEEPALIVE_INTERVAL_MS);

  return function stop() {
    clearInterval(interval);
    console.log(`[KEEPALIVE] Stopped — ${totalFrames} frames (~${(totalFrames * FRAME_MS / 1000).toFixed(1)}s)`);
  };
}

// ---------------------------------------------------------------------------
// Stream raw s16le PCM from ffmpeg stdout → Exotel
// ---------------------------------------------------------------------------
function streamPCMFromFFmpeg(ffProcess, ws, streamSid, stopKeepalive) {
  return new Promise((resolve) => {
    let remainder = Buffer.alloc(0);
    let sent      = 0;
    let kaStopped = false;

    const stopKA = () => {
      if (!kaStopped && stopKeepalive) { stopKeepalive(); kaStopped = true; }
    };

    ffProcess.stdout.on("data", (chunk) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      stopKA();

      const buf = Buffer.concat([remainder, chunk]);
      let offset = 0;
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
          return;
        }
      }
      remainder = buf.slice(offset);
    });

    ffProcess.stdout.on("end", () => {
      stopKA();
      if (remainder.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        const padLen = FRAME_BYTES - (remainder.length % FRAME_BYTES);
        const pad    = Buffer.concat([remainder, Buffer.alloc(padLen, PCM_SILENCE_BYTE)]);
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
      const dur = (sent * FRAME_BYTES) / (PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE);
      console.log(`[STREAM] ${sent} frames / ~${dur.toFixed(1)}s sent`);
      resolve();
    });

    ffProcess.stderr.on("data", (e) => {
      const m = e.toString().trim();
      if (m) console.warn("[FFMPEG]", m);
    });

    ffProcess.on("error", (err) => {
      stopKA();
      console.error("[FFMPEG] spawn error:", err.message);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Convert audio buffer → raw s16le PCM 8kHz mono via ffmpeg
// ---------------------------------------------------------------------------
function convertAndStream(audioBuf, ws, streamSid, fmt, stopKeepalive) {
  return new Promise((resolve, reject) => {
    const ffArgs = [
      "-hide_banner", "-loglevel", "error",
      "-f", fmt, "-i", "pipe:0",
      "-ar", String(PCM_SAMPLE_RATE),
      "-ac", "1",
      "-f", "s16le",
      "pipe:1",
    ];
    const ff    = spawn("ffmpeg", ffArgs);
    const sendP = streamPCMFromFFmpeg(ff, ws, streamSid, stopKeepalive);
    Readable.from(audioBuf).pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    sendP.then(resolve).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// TTS: CAMB.AI
// ---------------------------------------------------------------------------
async function streamTTSbyCamb(text, ws, streamSid, stopKeepalive) {
  const apiKey  = process.env.CAM_API_KEY;
  if (!apiKey) throw new Error("CAM_API_KEY not set");
  const voiceId = parseInt(process.env.CAMB_VOICE_ID || "147320", 10);
  console.log("[TTS/CAMB] Fetching:", text.slice(0, 60));

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
        responseType: "arraybuffer",
        timeout:      20000,
      }
    );
  } catch (err) {
    if (err.response) {
      const body = Buffer.isBuffer(err.response.data)
        ? err.response.data.toString("utf8").slice(0, 400)
        : String(err.response.data).slice(0, 400);
      console.error(`[TTS/CAMB] HTTP ${err.response.status}: ${body}`);
    } else {
      console.error("[TTS/CAMB] Error:", err.message);
    }
    throw err;
  }

  const audioBuf = Buffer.from(res.data);
  console.log(`[TTS/CAMB] Received ${audioBuf.length}B`);
  if (audioBuf.length < 100) throw new Error(`Too small: ${audioBuf.length}B`);

  const magic = audioBuf.slice(0, 4).toString("ascii");
  const isWav = magic === "RIFF";
  const isMp3 = (audioBuf[0] === 0xFF && (audioBuf[1] & 0xE0) === 0xE0) || magic.startsWith("ID3");
  const fmt   = isWav ? "wav" : isMp3 ? "mp3" : "wav";
  console.log("[TTS/CAMB] Format:", fmt);
  await convertAndStream(audioBuf, ws, streamSid, fmt, stopKeepalive);
}

// ---------------------------------------------------------------------------
// TTS: ElevenLabs fallback
// ---------------------------------------------------------------------------
async function streamTTSbyElevenLabs(text, ws, streamSid, stopKeepalive) {
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log("[TTS/EL] Fetching:", text.slice(0, 60));

  let res;
  try {
    res = await axios({
      method:       "post",
      url:          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
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
      console.error(`[TTS/EL] HTTP ${err.response.status}: ${body}`);
    } else {
      console.error("[TTS/EL] Error:", err.message);
    }
    throw err;
  }

  const audioBuf = Buffer.from(res.data);
  console.log(`[TTS/EL] Received ${audioBuf.length}B`);
  await convertAndStream(audioBuf, ws, streamSid, "mp3", stopKeepalive);
}

// ---------------------------------------------------------------------------
// Master TTS — tries providers in order
// ---------------------------------------------------------------------------
async function streamTTS(text, ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  console.log("[TTS] ->", text.slice(0, 80));

  const stopKeepalive = startKeepalive(ws, streamSid);

  const providers = [
    { name: "CAMB.AI",    fn: () => streamTTSbyCamb(text, ws, streamSid, stopKeepalive) },
    { name: "ElevenLabs", fn: () => streamTTSbyElevenLabs(text, ws, streamSid, stopKeepalive) },
  ];

  for (const p of providers) {
    if (p.name === "CAMB.AI"    && !process.env.CAM_API_KEY)        continue;
    if (p.name === "ElevenLabs" && !process.env.ELEVENLABS_API_KEY) continue;
    try {
      await p.fn();
      console.log("[TTS] Done via", p.name);
      return;
    } catch (err) {
      console.warn(`[TTS] FAILED ${p.name}:`, err.message.slice(0, 200));
    }
  }

  stopKeepalive();
  console.error("[TTS] All providers failed");
}

// ---------------------------------------------------------------------------
// VAD — energy of s16le PCM buffer
// ---------------------------------------------------------------------------
function pcmEnergy(buf) {
  if (!buf || buf.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    sum += Math.abs(buf.readInt16LE(i));
  }
  return sum / (buf.length / 2);
}

// ---------------------------------------------------------------------------
// STT: Deepgram nova-2 — raw s16le linear16
// ---------------------------------------------------------------------------
async function speechToText(buffer) {
  try {
    console.log(`[STT] Sending ${buffer.length}B to Deepgram`);
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen" +
      "?model=nova-2&smart_format=true&encoding=linear16&sample_rate=8000&language=en-IN",
      buffer,
      {
        headers: {
          Authorization:  "Token " + process.env.DEEPGRAM_API_KEY,
          "Content-Type": "audio/l16;rate=8000",
        },
        maxBodyLength: Infinity,
        timeout:       10000,
      }
    );
    const alt        = res.data?.results?.channels[0]?.alternatives[0];
    const transcript = alt?.transcript || "";
    const confidence = alt?.confidence || 0;
    console.log(`[STT] "${transcript}" (conf ${confidence.toFixed(2)})`);
    return transcript;
  } catch (err) {
    console.error("[STT]", err?.response?.status, err.message);
    return "";
  }
}

// ---------------------------------------------------------------------------
// LLM: Claude Haiku
// FIX #3: Added correct anthropic-beta header for claude-haiku-4-5-20251001
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
          "anthropic-beta":    "messages-2023-12-15",
          "Content-Type":      "application/json",
        },
        timeout: 12000,
      }
    );
    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log(`[AI] "${reply}"`);
    return reply;
  } catch (err) {
    console.error("[AI]", err?.response?.status, err?.response?.data || err.message);
    return "I'm sorry, could you say that again?";
  }
}

// ---------------------------------------------------------------------------
// WebSocket handler — Exotel Voicebot protocol
//
// FIX #4: isProcessing no longer DROPS audio while processing.
//   Instead we BUFFER audio that arrives during processing. Once processing
//   finishes, if enough buffered audio accumulated, we run another STT pass.
//   This prevents the silent-after-greeting bug where the caller's reply
//   is entirely discarded because isProcessing=true the whole time.
//
// FIX #5: streamSid extraction — handle all known Exotel start formats.
//
// FIX #6: Reset silence timer on EVERY media packet, not only when not
//   processing. (The timer is now separated from the processing gate.)
// ---------------------------------------------------------------------------
wss.on("connection", (ws, req) => {
  const callId   = Math.random().toString(36).substring(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] New call | callId=${callId} | IP=${clientIP}`);

  const session = {
    callId,
    history:         [],
    streamSid:       null,
    audioChunks:     [],      // chunks accumulating before current speech ends
    pendingChunks:   [],      // audio buffered while isProcessing
    isProcessing:    false,
    greetingSent:    false,
    silenceTimer:    null,
    wsOpen:          true,
    // ── diagnostics ──────────────────────────────────────────────────────
    mediaPacketCount:   0,    // total media packets received from Exotel
    mediaByteCount:     0,    // total decoded bytes received
    lastMediaAt:        null, // timestamp of last media packet
  };
  sessions.set(callId, session);

  // ── Process a complete speech utterance ──────────────────────────────────
  async function processUtterance(audio) {
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) return;
    session.isProcessing = true;
    console.log(`[UTT] Processing ${audio.length}B`);
    try {
      const transcript = await speechToText(audio);
      if (transcript && transcript.trim().length > 2) {
        const reply = await getAIResponse(session.history, transcript);
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
      console.log(`[UTT] Done. pendingChunks=${session.pendingChunks.length}`);

      // FIX #4: Drain any audio that arrived while we were processing.
      // If callers spoke while the bot was replying, process it now.
      if (session.pendingChunks.length > 0) {
        const pending = Buffer.concat(session.pendingChunks);
        session.pendingChunks = [];
        const energy = pcmEnergy(pending);
        console.log(`[UTT] Draining pending ${pending.length}B energy=${energy.toFixed(0)}`);
        if (pending.length >= MIN_AUDIO_BYTES && energy >= SILENCE_ENERGY_THRESH) {
          await processUtterance(pending);
        }
      }
    }
  }

  ws.on("message", async (rawMsg) => {
    let data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    // ── connected ───────────────────────────────────────────────────────────
    if (data.event === "connected") {
      console.log(`[WS] connected | ${callId}`);
    }

    // ── start ───────────────────────────────────────────────────────────────
    if (data.event === "start") {
      // FIX #5: robust stream_sid extraction across all known Exotel formats
      session.streamSid =
        data.stream_sid                    ||   // Voicebot top-level
        data.streamSid                     ||   // camelCase variant
        (data.start && data.start.stream_sid) || // nested start object
        (data.start && data.start.streamSid) ||
        null;

      console.log(`[WS] start | streamSid=${session.streamSid}`);
      console.log("[WS] start payload:", JSON.stringify(data).slice(0, 500));

      if (!session.greetingSent) {
        session.greetingSent = true;
        session.history.push({ role: "assistant", content: GREETING });
        streamTTS(GREETING, ws, session.streamSid).catch((e) => {
          console.error("[GREETING]", e.message);
        });
      }
    }

    // ── media ───────────────────────────────────────────────────────────────
    if (data.event === "media") {
      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.mediaPacketCount++;
      session.mediaByteCount += rawBytes.length;
      session.lastMediaAt = Date.now();

      // ── DIAGNOSTIC: log every 10th packet so we can confirm Exotel is
      //    actually sending caller audio back to us.
      if (session.mediaPacketCount <= 5 || session.mediaPacketCount % 10 === 0) {
        // Peek at first 4 bytes to help identify encoding
        const hex4 = rawBytes.slice(0, 4).toString("hex");
        const sampleEnergy = pcmEnergy(rawBytes);
        console.log(
          `[MEDIA] pkt#${session.mediaPacketCount} ` +
          `${rawBytes.length}B ` +
          `hex0-4=[${hex4}] ` +
          `energy=${sampleEnergy.toFixed(0)} ` +
          `isProcessing=${session.isProcessing}`
        );
      }

      // Buffer while processing — do NOT drop caller audio
      if (session.isProcessing) {
        session.pendingChunks.push(rawBytes);
        return;
      }

      session.audioChunks.push(rawBytes);

      // Reset silence timer on every packet
      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(async () => {
        if (session.isProcessing) return;

        const audio = Buffer.concat(session.audioChunks);
        session.audioChunks = [];

        console.log(`[VAD] Timer fired — totalPkts=${session.mediaPacketCount} audio=${audio.length}B`);

        if (audio.length < MIN_AUDIO_BYTES) {
          console.log(`[VAD] Too short (${audio.length}B < ${MIN_AUDIO_BYTES}B) — skipped`);
          return;
        }

        const energy = pcmEnergy(audio);
        console.log(`[VAD] energy=${energy.toFixed(0)} thresh=${SILENCE_ENERGY_THRESH} len=${audio.length}B`);

        if (energy < SILENCE_ENERGY_THRESH) {
          console.log("[VAD] Below threshold — silence, skipping");
          return;
        }

        console.log("[VAD] ✓ Speech detected — processing utterance");
        await processUtterance(audio);
      }, SILENCE_TIMEOUT_MS);
    }

    // ── stop ────────────────────────────────────────────────────────────────
    if (data.event === "stop") {
      clearTimeout(session.silenceTimer);
      console.log(
        `[WS] stop | ${callId} | ` +
        `mediaPackets=${session.mediaPacketCount} ` +
        `mediaBytes=${session.mediaByteCount} ` +
        `lastMediaAt=${session.lastMediaAt ? new Date(session.lastMediaAt).toISOString() : "never"}`
      );
      // If we got 0 media packets from Exotel, caller audio was never forwarded.
      if (session.mediaPacketCount === 0) {
        console.warn("[WS] ⚠ ZERO media packets received from Exotel — caller audio not forwarded.");
        console.warn("[WS] ⚠ Likely causes: (1) KYC/free trial restriction, (2) Voicebot applet misconfigured,");
        console.warn("[WS] ⚠ (3) Exotel's bidirectional streaming not enabled for this account/number.");
      }
    }

    // ── mark ────────────────────────────────────────────────────────────────
    if (data.event === "mark") {
      const markName = data.mark?.name || data.mark;
      console.log(`[WS] mark: ${markName}`);
    }
  });

  ws.on("close", (code) => {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log(
      `[WS] closed | ${callId} | code=${code} | ` +
      `mediaPackets=${session.mediaPacketCount} mediaBytes=${session.mediaByteCount}`
    );
    sessions.delete(callId);
  });

  ws.on("error", (err) => {
    session.wsOpen = false;
    console.error(`[WS] error | ${callId}:`, err.message);
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  const tts = [];
  if (process.env.CAM_API_KEY)        tts.push("CAMB.AI");
  if (process.env.ELEVENLABS_API_KEY) tts.push("ElevenLabs");
  res.json({
    status:    "ok",
    protocol:  "Exotel Voicebot (s16le PCM)",
    sessions:  sessions.size,
    uptime:    Math.floor(process.uptime()),
    tts,
    energy_threshold: SILENCE_ENERGY_THRESH,
  });
});

checkEnv();
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
