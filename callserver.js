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

const PCM_SAMPLE_RATE      = 8000;
const PCM_BYTES_PER_SAMPLE = 2;         // s16le = 2 bytes/sample
const FRAME_MS             = 20;
const FRAME_BYTES          = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * FRAME_MS / 1000; // 320

const SILENCE_TIMEOUT_MS    = 600;
const SILENCE_ENERGY_THRESH = parseInt(process.env.ENERGY_THRESH || "20", 10);
const PCM_AMPLIFY           = parseFloat(process.env.PCM_AMPLIFY  || "40");
const MIN_AUDIO_BYTES       = 3200;    // 100ms minimum before STT attempt

const KEEPALIVE_INTERVAL_MS      = 200;
const KEEPALIVE_FRAMES_PER_BURST = 10;
const PCM_SILENCE_BYTE           = 0x00;

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
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error("Missing env vars:", missing.join(", "));
    process.exit(1);
  }
  if (!process.env.CAM_API_KEY && !process.env.ELEVENLABS_API_KEY) {
    console.error("No TTS provider configured. Set CAM_API_KEY or ELEVENLABS_API_KEY.");
    process.exit(1);
  }
  const providers = [];
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
// Keepalive — silence bursts while waiting for TTS network round-trip
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
// Stream s16le PCM from ffmpeg stdout to Exotel
// ---------------------------------------------------------------------------
function streamPCMFromFFmpeg(ffProcess, ws, streamSid, stopKeepalive) {
  return new Promise(resolve => {
    let remainder = Buffer.alloc(0);
    let sent      = 0;
    let kaStopped = false;

    function stopKA() {
      if (!kaStopped && stopKeepalive) { stopKeepalive(); kaStopped = true; }
    }

    ffProcess.stdout.on("data", chunk => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      stopKA();

      const buf    = Buffer.concat([remainder, chunk]);
      let   offset = 0;
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

    ffProcess.stderr.on("data", e => {
      const m = e.toString().trim();
      if (m) console.warn("[FFMPEG]", m);
    });

    ffProcess.on("error", err => {
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
// Master TTS — always resets isSpeaking even on failure
// ---------------------------------------------------------------------------
async function streamTTS(text, ws, streamSid, session) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!streamSid) {
    console.error("[TTS] No streamSid — cannot send audio");
    return;
  }
  console.log("[TTS] ->", text.slice(0, 80));
  if (session) session.isSpeaking = true;

  const stopKeepalive = startKeepalive(ws, streamSid);

  const providers = [
    {
      name: "CAMB.AI",
      enabled: !!process.env.CAM_API_KEY,
      fn: () => streamTTSbyCamb(text, ws, streamSid, stopKeepalive),
    },
    {
      name: "ElevenLabs",
      enabled: !!process.env.ELEVENLABS_API_KEY,
      fn: () => streamTTSbyElevenLabs(text, ws, streamSid, stopKeepalive),
    },
  ];

  let succeeded = false;
  for (const p of providers) {
    if (!p.enabled) continue;
    try {
      await p.fn();
      console.log("[TTS] Done via", p.name);
      succeeded = true;
      break;
    } catch (err) {
      console.warn(`[TTS] FAILED ${p.name}:`, err.message.slice(0, 200));
    }
  }

  // CRITICAL: always stop keepalive and clear isSpeaking — even on failure.
  // If we don't, isSpeaking stays true forever and no caller audio is processed.
  stopKeepalive();
  if (!succeeded) console.error("[TTS] All providers failed");
  if (session) session.isSpeaking = false;
}

// ---------------------------------------------------------------------------
// VAD: mean absolute energy of s16le PCM buffer
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
// Amplify s16le PCM
// ---------------------------------------------------------------------------
function amplifyPCM(buf, gain) {
  if (!gain || gain === 1) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const sample    = buf.readInt16LE(i);
    let   amplified = Math.round(sample * gain);
    if (amplified >  32767) amplified =  32767;
    if (amplified < -32768) amplified = -32768;
    out.writeInt16LE(amplified, i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trim silence from PCM buffer
// ---------------------------------------------------------------------------
function trimSpeechPCM(buf, energyThresh) {
  const frames = [];
  for (let i = 0; i + FRAME_BYTES <= buf.length; i += FRAME_BYTES) {
    frames.push(buf.slice(i, i + FRAME_BYTES));
  }
  let first = -1, last = -1;
  for (let f = 0; f < frames.length; f++) {
    if (pcmEnergy(frames[f]) >= energyThresh) {
      if (first === -1) first = f;
      last = f;
    }
  }
  if (first === -1) return buf;
  const padFrames = 10;
  first = Math.max(0, first - padFrames);
  last  = Math.min(frames.length - 1, last + padFrames);
  const trimmed = Buffer.concat(frames.slice(first, last + 1));
  console.log(`[TRIM] ${frames.length} frames -> ${last - first + 1} frames (kept ${first}-${last})`);
  return trimmed;
}

// ---------------------------------------------------------------------------
// STT: Deepgram nova-2
// ---------------------------------------------------------------------------
async function speechToText(rawBuffer) {
  const trimmed    = trimSpeechPCM(rawBuffer, SILENCE_ENERGY_THRESH);
  const amplified  = amplifyPCM(trimmed, PCM_AMPLIFY);
  const preEnergy  = pcmEnergy(trimmed).toFixed(0);
  const postEnergy = pcmEnergy(amplified).toFixed(0);
  console.log(`[STT] ${amplified.length}B | energy raw=${preEnergy} amplified=${postEnergy} (gain=${PCM_AMPLIFY}x)`);

  try {
    const res = await axios.post(
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
// FIX: removed invalid "anthropic-beta: messages-2023-12-15" header —
//      this caused silent 400 rejections from the Anthropic API.
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
          "anthropic-version": "2023-06-01",   // only valid header needed
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
// ---------------------------------------------------------------------------
wss.on("connection", (ws, req) => {
  const callId   = Math.random().toString(36).substring(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] New call | callId=${callId} | IP=${clientIP}`);

  const session = {
    callId,
    history:          [],
    streamSid:        null,
    audioChunks:      [],
    pendingChunks:    [],
    isProcessing:     false,
    isSpeaking:       false,
    greetingSent:     false,
    silenceTimer:     null,
    wsOpen:           true,
    mediaPacketCount: 0,
    mediaByteCount:   0,
    lastMediaAt:      null,
  };
  sessions.set(callId, session);

  // ── Process one complete utterance ─────────────────────────────────────
  async function processUtterance(audio) {
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) return;
    session.isProcessing = true;
    console.log(`[UTT] Processing ${audio.length}B`);
    try {
      const transcript = await speechToText(audio);
      if (transcript && transcript.trim().length > 2) {
        const reply = await getAIResponse(session.history, transcript);
        if (session.wsOpen && ws.readyState === WebSocket.OPEN) {
          await streamTTS(reply, ws, session.streamSid, session);
        }
      } else {
        console.log("[UTT] Empty/short transcript — skipping");
      }
    } catch (err) {
      console.error("[UTT] Error:", err.message);
    } finally {
      session.isProcessing = false;
      console.log(`[UTT] Done. pending=${session.pendingChunks.length} pkts`);

      // Drain audio buffered while we were processing
      if (session.pendingChunks.length > 0) {
        const pending = Buffer.concat(session.pendingChunks);
        session.pendingChunks = [];
        const energy = pcmEnergy(pending);
        console.log(`[UTT] Draining ${pending.length}B energy=${energy.toFixed(0)}`);
        // Only re-process if the buffered audio has actual speech energy
        if (pending.length >= MIN_AUDIO_BYTES && energy >= SILENCE_ENERGY_THRESH) {
          await processUtterance(pending);
        }
      }
    }
  }

  // ── flushAudio — evaluate buffered audio and run STT if speech found ───
  // Defined once per session (not inside message handler) to avoid closure bugs.
  async function flushAudio(trigger) {
    if (session.isProcessing) {
      console.log(`[VAD] flushAudio skipped (processing) trigger=${trigger}`);
      return;
    }
    if (session.audioChunks.length === 0) {
      console.log(`[VAD] flushAudio — no chunks trigger=${trigger}`);
      return;
    }
    const audio = Buffer.concat(session.audioChunks);
    session.audioChunks = [];
    console.log(`[VAD] flushAudio trigger=${trigger} audio=${audio.length}B pkts=${session.mediaPacketCount}`);
    if (audio.length < MIN_AUDIO_BYTES) {
      console.log(`[VAD] Too short (${audio.length}B) — skipped`);
      return;
    }
    const energy = pcmEnergy(audio);
    console.log(`[VAD] energy=${energy.toFixed(0)} thresh=${SILENCE_ENERGY_THRESH}`);
    if (energy < SILENCE_ENERGY_THRESH) {
      console.log("[VAD] Silence — skipping");
      return;
    }
    console.log(`[VAD] Speech via ${trigger} — processing`);
    await processUtterance(audio);
  }

  // ── Message handler ─────────────────────────────────────────────────────
  ws.on("message", async rawMsg => {
    let data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    // connected
    if (data.event === "connected") {
      console.log(`[WS] connected | ${callId}`);
    }

    // start — FIX: guard against duplicate start events from Exotel
    if (data.event === "start") {
      const sid =
        data.stream_sid ||
        data.streamSid  ||
        data.start?.stream_sid ||
        data.start?.streamSid  ||
        null;

      console.log(`[WS] start | streamSid=${sid}`);
      console.log("[WS] start payload:", JSON.stringify(data).slice(0, 500));

      // Update streamSid regardless — Exotel may send it only in first start
      if (sid) session.streamSid = sid;

      // FIX: only send greeting once AND only after streamSid is confirmed
      if (!session.greetingSent && session.streamSid) {
        session.greetingSent = true;
        session.history.push({ role: "assistant", content: GREETING });
        // Slight delay to let Exotel's media stream settle before we push audio
        setTimeout(() => {
          streamTTS(GREETING, ws, session.streamSid, session).catch(e => {
            console.error("[GREETING]", e.message);
          });
        }, 300);
      } else if (!session.streamSid) {
        console.warn("[WS] start received but no streamSid found — greeting deferred");
      }
    }

    // media — THE HOT PATH
    if (data.event === "media") {
      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.mediaPacketCount++;
      session.mediaByteCount += rawBytes.length;
      session.lastMediaAt = Date.now();

      // FIX: if streamSid arrived late (some Exotel deployments), capture it from media
      if (!session.streamSid && data.stream_sid) {
        session.streamSid = data.stream_sid;
        console.log(`[WS] streamSid captured from media: ${session.streamSid}`);
        if (!session.greetingSent) {
          session.greetingSent = true;
          session.history.push({ role: "assistant", content: GREETING });
          setTimeout(() => {
            streamTTS(GREETING, ws, session.streamSid, session).catch(e => {
              console.error("[GREETING/late]", e.message);
            });
          }, 300);
        }
      }

      // Log every packet for first 10, then every 100th — better visibility
      if (session.mediaPacketCount <= 10 || session.mediaPacketCount % 100 === 0) {
        const hex4   = rawBytes.slice(0, 4).toString("hex");
        const pktEng = pcmEnergy(rawBytes).toFixed(0);
        console.log(
          `[MEDIA] pkt#${session.mediaPacketCount} ${rawBytes.length}B` +
          ` hex=[${hex4}] energy=${pktEng}` +
          ` speaking=${session.isSpeaking} processing=${session.isProcessing}`
        );
      }

      // Discard audio while bot is speaking — just echo/line noise
      if (session.isSpeaking) return;

      // Buffer caller audio while STT/LLM is running
      if (session.isProcessing) {
        session.pendingChunks.push(rawBytes);
        return;
      }

      session.audioChunks.push(rawBytes);

      // Reset silence timer on every packet
      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(() => {
        flushAudio("silence-timer");
      }, SILENCE_TIMEOUT_MS);
    }

    // stop — flush immediately; don't rely on silence timer alone
    if (data.event === "stop") {
      clearTimeout(session.silenceTimer);
      console.log(
        `[WS] stop | ${callId}` +
        ` | mediaPackets=${session.mediaPacketCount}` +
        ` | mediaBytes=${session.mediaByteCount}` +
        ` | lastMediaAt=${session.lastMediaAt ? new Date(session.lastMediaAt).toISOString() : "never"}`
      );
      if (session.mediaPacketCount === 0) {
        console.warn("[WS] WARNING: ZERO media packets received from Exotel — check your applet config");
      }
      await flushAudio("stop-event");
    }

    // mark
    if (data.event === "mark") {
      const markName = data.mark?.name || data.mark;
      console.log("[WS] mark:", markName);
      // tts_done mark confirms Exotel finished playing our audio
      if (markName === "tts_done" && session) {
        console.log("[WS] tts_done mark received — bot playback confirmed complete");
      }
    }
  });

  ws.on("close", code => {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log(
      `[WS] closed | ${callId}` +
      ` | code=${code}` +
      ` | mediaPackets=${session.mediaPacketCount}` +
      ` | mediaBytes=${session.mediaByteCount}`
    );
    sessions.delete(callId);
  });

  ws.on("error", err => {
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
    status:           "ok",
    protocol:         "Exotel Voicebot s16le PCM",
    sessions:         sessions.size,
    uptime:           Math.floor(process.uptime()),
    tts,
    energy_threshold: SILENCE_ENERGY_THRESH,
    pcm_amplify:      PCM_AMPLIFY,
  });
});

checkEnv();
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
