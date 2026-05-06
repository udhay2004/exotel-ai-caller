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

// ===========================================================================
// THE REAL PROBLEMS THIS FILE FIXES:
//
// 1. Exotel sends MULAW (G.711 u-law), not linear16.
//    Proof: your silence energy was ~122 in raw bytes (mulaw silence = 0x7F = 127).
//    Sending mulaw bytes to Deepgram as "linear16" = garbled garbage = empty transcripts.
//    Fix: decode mulaw→linear16 on every packet. Send decoded PCM to Deepgram.
//
// 2. Keepalive silence bytes were linear16 (0x00).
//    Exotel expects MULAW back. Sending 0x00 bytes = loud noise on the call.
//    Fix: keepalive uses mulaw silence byte (0xFF).
//
// 3. ElevenLabs 401 = no paid plan. CAMB.AI fallback takes 4-5s.
//    Fix: CAMB.AI is still used but the silence frames are now correct so
//    the caller hears the audio properly.
//
// 4. VAD threshold was calibrated for linear16 (500+) but got applied to
//    raw mulaw bytes (where silence=122, speech=90-122 — nearly identical).
//    Fix: after mulaw→linear16 decode, silence=~0, speech=500-5000.
//    Threshold of 300 now correctly separates them.
//
// 5. Echo suppression was discarding REAL caller speech.
//    Exotel does NOT echo the bot's audio back on outbound calls.
//    The "echo" was actually the caller speaking while the bot played audio.
//    Fix: removed echo suppression. Barge-in handled properly instead.
// ===========================================================================

const SAMPLE_RATE   = 8000;
const BYTES_PER_S   = SAMPLE_RATE * 1; // mulaw = 1 byte/sample
const PCM_BYTES_PER_S = SAMPLE_RATE * 2; // linear16 = 2 bytes/sample
const FRAME_BYTES   = 160; // 20ms of mulaw (160 bytes) = 320 bytes PCM

const SILENCE_MS    = parseInt(process.env.SILENCE_TIMEOUT  || "900",  10);
const ENERGY_THRESH = parseInt(process.env.ENERGY_THRESH    || "300",  10);
const MIN_DURATION_MS = parseInt(process.env.MIN_DURATION_MS || "600", 10);
const MIN_PCM_BYTES = (MIN_DURATION_MS / 1000) * PCM_BYTES_PER_S;

const KEEPALIVE_MS     = 200;
const KEEPALIVE_FRAMES = 10;
const MULAW_SILENCE    = 0xFF; // G.711 mulaw silence codeword
const PCM_SILENCE_BYTE = 0x00;

const COMPANY_CONTEXT =
  "You are a professional telecaller from Connect Ventures. " +
  "Keep every response to 1-2 short sentences. " +
  "Be warm, clear, and concise. Never repeat what the caller just said. " +
  "Do not use lists, bullet points, or special characters.";

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const sessions = new Map();

// ---------------------------------------------------------------------------
// G.711 mulaw → linear16 decode table (pre-computed, fast)
// ---------------------------------------------------------------------------
const MULAW_TO_LINEAR = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const b    = ~i & 0xFF;
    const sign = (b & 0x80) ? -1 : 1;
    const exp  = (b >> 4) & 0x07;
    const mant = b & 0x0F;
    t[i] = sign * (((mant << 1) + 33) << (exp + 1)) - sign * 33;
  }
  return t;
})();

function mulawToLinear16(mulawBuf) {
  const pcm = Buffer.allocUnsafe(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm.writeInt16LE(MULAW_TO_LINEAR[mulawBuf[i]], i * 2);
  }
  return pcm;
}

// ---------------------------------------------------------------------------
// VAD — operates on decoded linear16 PCM
// ---------------------------------------------------------------------------
function pcmEnergy(pcmBuf) {
  if (!pcmBuf || pcmBuf.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < pcmBuf.length; i += 2) {
    sum += Math.abs(pcmBuf.readInt16LE(i));
  }
  return sum / (pcmBuf.length >> 1);
}

// ---------------------------------------------------------------------------
// Env check
// ---------------------------------------------------------------------------
function checkEnv() {
  const required = ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY"];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error("❌ Missing env vars:", missing.join(", "));
    process.exit(1);
  }
  if (!process.env.ELEVENLABS_API_KEY && !process.env.CAM_API_KEY) {
    console.error("❌ No TTS provider. Set ELEVENLABS_API_KEY or CAM_API_KEY.");
    process.exit(1);
  }
  const tts = [];
  if (process.env.ELEVENLABS_API_KEY) tts.push("ElevenLabs (streaming)");
  if (process.env.CAM_API_KEY)        tts.push("CAMB.AI");
  console.log("✅ Env OK | TTS:", tts.join(" -> "));
  console.log(`   Silence: ${SILENCE_MS}ms | Energy thresh: ${ENERGY_THRESH} | Min duration: ${MIN_DURATION_MS}ms`);
  console.log("   Audio pipeline: Exotel mulaw → decode → linear16 → Deepgram");
  console.log("   Keepalive: mulaw silence (0xFF) — correct for Exotel");
}

// ---------------------------------------------------------------------------
// Keepalive — MULAW silence frames (NOT linear16!)
// Exotel encodes in mulaw. Sending linear16 zeros = audible noise.
// ---------------------------------------------------------------------------
function mulawSilenceFrame() {
  // 160 bytes of 0xFF = 20ms of mulaw silence
  return Buffer.alloc(FRAME_BYTES, MULAW_SILENCE).toString("base64");
}

function sendSilenceFrame(ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({
      event:      "media",
      stream_sid: streamSid,
      media:      { payload: mulawSilenceFrame() },
    }));
  } catch (_) {}
}

function startKeepalive(ws, streamSid) {
  let total = 0;
  const iv = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { clearInterval(iv); return; }
    for (let i = 0; i < KEEPALIVE_FRAMES; i++) { sendSilenceFrame(ws, streamSid); total++; }
  }, KEEPALIVE_MS);
  return () => { clearInterval(iv); console.log(`[KA] stopped — ${total} mulaw frames`); };
}

// ---------------------------------------------------------------------------
// Stream ffmpeg output → Exotel
// ffmpeg converts TTS audio (mp3/wav) to mulaw 8kHz for Exotel
// ---------------------------------------------------------------------------
function streamAudioFromFFmpeg(ff, ws, streamSid, stopKA) {
  return new Promise(resolve => {
    let rem = Buffer.alloc(0), sent = 0, stopped = false;

    const doStop = () => {
      if (!stopped && stopKA) { stopKA(); stopped = true; }
    };

    ff.stdout.on("data", chunk => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      doStop();
      const buf = Buffer.concat([rem, chunk]);
      let off = 0;
      while (off + FRAME_BYTES <= buf.length) {
        try {
          ws.send(JSON.stringify({
            event: "media", stream_sid: streamSid,
            media: { payload: buf.slice(off, off + FRAME_BYTES).toString("base64") },
          }));
          sent++;
        } catch (e) { console.warn("[STREAM] send err:", e.message); break; }
        off += FRAME_BYTES;
      }
      rem = buf.slice(off);
    });

    ff.stdout.on("end", () => {
      doStop();
      // Flush remaining bytes padded to frame boundary
      if (rem.length && ws?.readyState === WebSocket.OPEN) {
        const pad = Buffer.concat([rem, Buffer.alloc(FRAME_BYTES - (rem.length % FRAME_BYTES), MULAW_SILENCE)]);
        try {
          ws.send(JSON.stringify({ event: "media", stream_sid: streamSid, media: { payload: pad.toString("base64") } }));
          sent++;
        } catch (_) {}
      }
      // Send mark so we know TTS finished
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: "tts_done" } })); } catch (_) {}
      }
      const duration = ((sent * FRAME_BYTES) / BYTES_PER_S).toFixed(1);
      console.log(`[STREAM] ${sent} mulaw frames / ~${duration}s sent`);
      resolve();
    });

    ff.stderr.on("data", d => { const m = d.toString().trim(); if (m) console.warn("[FF]", m); });
    ff.on("error", err => { doStop(); console.error("[FF] error:", err.message); resolve(); });
  });
}

// Convert TTS buffer (mp3/wav) → mulaw 8kHz for Exotel
function convertAndStream(audioBuf, inputFmt, ws, streamSid, stopKA) {
  return new Promise((resolve, reject) => {
    // Output mulaw (u-law) at 8kHz mono
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", inputFmt, "-i", "pipe:0",
      "-ar", "8000", "-ac", "1",
      "-acodec", "pcm_mulaw",  // G.711 u-law output
      "-f", "mulaw",
      "pipe:1",
    ]);
    Readable.from(audioBuf).pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    streamAudioFromFFmpeg(ff, ws, streamSid, stopKA).then(resolve).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// TTS providers
// ---------------------------------------------------------------------------
async function ttsViaElevenLabs(text, ws, streamSid, stopKA) {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error("no ELEVENLABS_API_KEY");
  const vid = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
  console.log("[TTS/EL] ->", text.slice(0, 60));

  // ffmpeg: mp3 stream → mulaw 8kHz
  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "mp3", "-i", "pipe:0",
    "-ar", "8000", "-ac", "1",
    "-acodec", "pcm_mulaw",
    "-f", "mulaw",
    "pipe:1",
  ]);
  const done = streamAudioFromFFmpeg(ff, ws, streamSid, stopKA);

  const response = await axios({
    method: "post",
    url: `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`,
    data: {
      text,
      model_id: "eleven_turbo_v2",
      output_format: "mp3_44100_128",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
    },
    headers: {
      "xi-api-key":   process.env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
    },
    responseType: "stream",
    timeout: 20000,
  });

  response.data.pipe(ff.stdin);
  response.data.on("error", e => { console.warn("[TTS/EL] stream err:", e.message); ff.stdin.end(); });
  ff.stdin.on("error", () => {});
  await done;
}

async function ttsViaCamb(text, ws, streamSid, stopKA) {
  if (!process.env.CAM_API_KEY) throw new Error("no CAM_API_KEY");
  console.log("[TTS/CAMB] ->", text.slice(0, 60));

  const res = await axios.post(
    "https://client.camb.ai/apis/tts-stream",
    {
      text,
      language:      "en-in",
      voice_id:      parseInt(process.env.CAMB_VOICE_ID || "147320", 10),
      speech_model:  "mars-flash",
      voice_settings: { speaking_rate: 1.05 },
    },
    {
      headers:      { "x-api-key": process.env.CAM_API_KEY, "Content-Type": "application/json" },
      responseType: "arraybuffer",
      timeout:      15000,
    }
  );

  const audio = Buffer.from(res.data);
  if (audio.length < 100) throw new Error(`CAMB too small: ${audio.length}B`);
  console.log(`[TTS/CAMB] ${audio.length}B`);

  const fmt = audio.slice(0, 4).toString("ascii") === "RIFF" ? "wav" : "mp3";
  await convertAndStream(audio, fmt, ws, streamSid, stopKA);
}

async function streamTTS(text, ws, streamSid, session) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !streamSid) {
    console.warn("[TTS] skip — ws not ready");
    return;
  }
  console.log("[TTS] ->", text.slice(0, 80));
  if (session) session.isSpeaking = true;

  const stopKA = startKeepalive(ws, streamSid);
  let ok = false;

  for (const [name, key, fn] of [
    ["ElevenLabs", "ELEVENLABS_API_KEY", () => ttsViaElevenLabs(text, ws, streamSid, stopKA)],
    ["CAMB.AI",    "CAM_API_KEY",        () => ttsViaCamb(text, ws, streamSid, stopKA)],
  ]) {
    if (!process.env[key]) continue;
    try {
      await fn();
      ok = true;
      console.log("[TTS] done via", name);
      break;
    } catch (e) {
      console.warn(`[TTS] ${name} failed:`, e.message.slice(0, 120));
    }
  }

  stopKA();
  if (!ok) console.error("[TTS] ❌ all providers failed");

  if (session) {
    session.isSpeaking = false;
    // Process any barge-in audio collected while bot was speaking
    if (session.bargeinChunks.length > 0 && !session.isProcessing) {
      const bargein = Buffer.concat(session.bargeinChunks);
      session.bargeinChunks = [];
      const energy = pcmEnergy(bargein);
      console.log(`[BARGE-IN] ${bargein.length}B energy=${energy.toFixed(0)} thresh=${ENERGY_THRESH}`);
      if (bargein.length >= MIN_PCM_BYTES && energy >= ENERGY_THRESH) {
        processUtterance(bargein, session, ws).catch(e => console.error("[BARGE-IN] err:", e.message));
      } else {
        console.log("[BARGE-IN] too short/quiet — skip");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// STT — decoded linear16 PCM → Deepgram
// ---------------------------------------------------------------------------
async function speechToText(pcmBuf) {
  const energy  = pcmEnergy(pcmBuf).toFixed(0);
  const seconds = (pcmBuf.length / PCM_BYTES_PER_S).toFixed(2);
  console.log(`[STT] ${pcmBuf.length}B (${seconds}s) energy=${energy}`);

  try {
    const res = await axios.post(
      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&encoding=linear16&sample_rate=8000&language=en-IN",
      pcmBuf,
      {
        headers: {
          Authorization:  "Token " + process.env.DEEPGRAM_API_KEY,
          "Content-Type": "audio/l16;rate=8000",
        },
        maxBodyLength: Infinity,
        timeout:       15000,
      }
    );
    const alt  = res.data?.results?.channels[0]?.alternatives[0];
    const text = alt?.transcript || "";
    console.log(`[STT] "${text}" (conf=${(alt?.confidence || 0).toFixed(2)})`);
    return text;
  } catch (e) {
    console.error("[STT] error:", e?.response?.status, e.message);
    return "";
  }
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------
async function getAIResponse(history, text) {
  history.push({ role: "user", content: text });
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:     "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system:    COMPANY_CONTEXT,
        messages:  history,
      },
      {
        headers: {
          "x-api-key":         process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 8000,
      }
    );
    const reply = res.data.content[0].text.trim();
    history.push({ role: "assistant", content: reply });
    console.log(`[AI] "${reply}"`);
    return reply;
  } catch (e) {
    console.error("[AI] error:", e?.response?.status, e?.response?.data || e.message);
    return "I'm sorry, could you say that again?";
  }
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------
async function processUtterance(pcmBuf, session, ws) {
  if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) {
    console.warn("[UTT] ws closed — abort");
    return;
  }
  const t0      = Date.now();
  const seconds = (pcmBuf.length / PCM_BYTES_PER_S).toFixed(2);
  console.log(`[UTT] start — ${pcmBuf.length}B (${seconds}s PCM)`);

  session.isProcessing = true;
  try {
    const transcript = await speechToText(pcmBuf);
    if (!transcript || transcript.trim().length < 2) {
      console.log("[UTT] empty transcript — skip");
      return;
    }
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) return;

    console.log(`[UTT] STT done in ${Date.now() - t0}ms`);
    const reply = await getAIResponse(session.history, transcript);
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) return;

    console.log(`[UTT] STT+AI done in ${Date.now() - t0}ms — starting TTS`);
    await streamTTS(reply, ws, session.streamSid, session);
    console.log(`[UTT] total pipeline ${Date.now() - t0}ms`);
  } catch (e) {
    console.error("[UTT] error:", e.message);
  } finally {
    session.isProcessing = false;
    if (session.pendingFlush) {
      session.pendingFlush = false;
      const pending = Buffer.concat(session.audioChunks);
      session.audioChunks = [];
      if (pending.length >= MIN_PCM_BYTES && pcmEnergy(pending) >= ENERGY_THRESH) {
        console.log(`[UTT] draining deferred: ${pending.length}B`);
        await processUtterance(pending, session, ws);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------
wss.on("connection", (ws, req) => {
  const callId   = Math.random().toString(36).slice(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[WS] New call | ${callId} | ${clientIP}`);

  const session = {
    callId,
    history:          [],
    streamSid:        null,
    audioChunks:      [],   // decoded linear16 PCM
    bargeinChunks:    [],   // decoded linear16 PCM (collected during bot speech)
    isProcessing:     false,
    isSpeaking:       false,
    pendingFlush:     false,
    greetingSent:     false,
    silenceTimer:     null,
    wsOpen:           true,
    pktCount:         0,
  };
  sessions.set(callId, session);

  async function flushAudio(trigger) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
    if (session.audioChunks.length === 0) {
      console.log(`[VAD] flush(${trigger}) — no audio buffered`);
      return;
    }
    const pcm     = Buffer.concat(session.audioChunks);
    session.audioChunks = [];
    const energy  = pcmEnergy(pcm);
    const seconds = (pcm.length / PCM_BYTES_PER_S).toFixed(2);
    console.log(`[VAD] flush(${trigger}) ${pcm.length}B ${seconds}s energy=${energy.toFixed(0)} thresh=${ENERGY_THRESH}`);

    if (pcm.length < MIN_PCM_BYTES)  { console.log("[VAD] too short — skip"); return; }
    if (energy < ENERGY_THRESH)       { console.log("[VAD] below threshold — skip"); return; }
    if (session.isProcessing)         { session.audioChunks = [pcm]; session.pendingFlush = true; console.log("[VAD] busy — pendingFlush"); return; }

    await processUtterance(pcm, session, ws);
  }

  function maybeGreet() {
    if (session.greetingSent || !session.streamSid) return;
    session.greetingSent = true;
    session.history.push({ role: "assistant", content: GREETING });
    console.log("[GREET] firing greeting TTS");
    streamTTS(GREETING, ws, session.streamSid, session).catch(e => {
      console.error("[GREET] TTS error:", e.message);
      if (session) session.isSpeaking = false;
    });
  }

  ws.on("message", async rawMsg => {
    let data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    if (data.event === "connected") {
      console.log(`[WS] connected | ${callId}`);
    }

    if (data.event === "start") {
      const sid = data.stream_sid
        || data.streamSid
        || data.start?.stream_sid
        || data.start?.streamSid
        || null;
      if (sid) session.streamSid = sid;
      console.log(`[WS] start | streamSid=${session.streamSid}`);
      maybeGreet();
    }

    if (data.event === "media") {
      // Exotel sends base64-encoded G.711 mulaw audio (8kHz, mono, 1 byte/sample)
      const mulawBytes = Buffer.from(data.media.payload, "base64");
      session.pktCount++;

      // Recover streamSid if missed in start event
      if (!session.streamSid) {
        const sid = data.stream_sid || data.media?.stream_sid || null;
        if (sid) {
          session.streamSid = sid;
          console.log(`[WS] streamSid recovered from media: ${session.streamSid}`);
        }
      }
      if (!session.greetingSent && session.streamSid) maybeGreet();

      // Decode mulaw → linear16 PCM for VAD and STT
      const pcmFrame = mulawToLinear16(mulawBytes);

      // Debug logging
      if (session.pktCount === 1) {
        const rawEnergy = mulawBytes.reduce((s, b) => s + Math.abs(b - 127), 0) / mulawBytes.length;
        const pcmE      = pcmEnergy(pcmFrame);
        console.log(`[AUDIO] First pkt: ${mulawBytes.length}B mulaw | raw_deviation=${rawEnergy.toFixed(0)} | pcmEnergy=${pcmE.toFixed(0)}`);
        console.log(`[AUDIO] First 16 mulaw bytes: ${mulawBytes.slice(0, 16).toString("hex")}`);
      }
      if (session.pktCount <= 10 || session.pktCount % 200 === 0) {
        console.log(`[MEDIA] pkt#${session.pktCount} pcmEnergy=${pcmEnergy(pcmFrame).toFixed(0)} speaking=${session.isSpeaking}`);
      }

      // If bot is speaking, collect for barge-in detection
      if (session.isSpeaking) {
        session.bargeinChunks.push(pcmFrame);
        return;
      }

      // Normal accumulation
      session.audioChunks.push(pcmFrame);
      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(() => flushAudio("silence-timer"), SILENCE_MS);
    }

    if (data.event === "stop") {
      clearTimeout(session.silenceTimer);
      console.log(`[WS] stop | ${callId} | pkts=${session.pktCount}`);
      flushAudio("stop-event").catch(e => console.error("[STOP]", e.message));
    }

    if (data.event === "mark") {
      console.log("[WS] mark:", data.mark?.name || data.mark);
    }
  });

  ws.on("close", code => {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    console.log(`[WS] closed | ${callId} | code=${code} | pkts=${session.pktCount}`);
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
  if (process.env.ELEVENLABS_API_KEY) tts.push("ElevenLabs");
  if (process.env.CAM_API_KEY)        tts.push("CAMB.AI");
  res.json({
    status:       "ok",
    sessions:     sessions.size,
    uptime:       Math.floor(process.uptime()),
    tts,
    audio_in:     "Exotel mulaw → decode → linear16 → Deepgram",
    audio_out:    "TTS mp3/wav → ffmpeg → mulaw → Exotel",
    energy_thresh: ENERGY_THRESH,
    silence_ms:   SILENCE_MS,
  });
});

checkEnv();
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
