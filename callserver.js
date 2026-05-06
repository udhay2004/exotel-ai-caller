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
// CONFIRMED FACTS:
//   EXOTEL SENDS:    linear16 s16le, 8kHz, mono, 320 bytes per 20ms frame
//   EXOTEL RECEIVES: linear16 s16le, 8kHz, mono, 320 bytes per 20ms frame
//   STT: send raw linear16 bytes directly to Deepgram — no conversion needed
//   VAD: silence ≈ 5-50, speech ≈ 300-8000 (Exotel near-silence = ~9)
//   ENERGY_THRESH: set in .env (default 80). Only flush AFTER real speech seen.
//
// BUGS FIXED (v2):
//   BUG-1: audioChunks NOT cleared before TTS starts → stale frames pollute
//          next utterance energy check. Fix: wipe state at TTS entry.
//   BUG-2: Barge-in audio silently dropped when energy < ENERGY_THRESH.
//          Fix: fold back into audioChunks so VAD can evaluate with follow-on
//          speech; arm silence timer at 60 % soft-threshold.
//   BUG-3: pendingFlush finally-block snapshots audioChunks AFTER new packets
//          arrived → new packets lost. Fix: snapshot+clear atomically, then
//          append whatever arrived during processing.
//   BUG-4: hasSpeech/silenceTimer race — new packet could re-arm timer while
//          flushAudio() was clearing it. Fix: capture hadSpeech before reset;
//          always clearTimeout at flushAudio() entry.
//   BUG-5: Pre-speech silence accumulates indefinitely. Fix: cap at 100 frames
//          (~2 s) of pre-speech context to prevent memory growth.
//   BUG-6: isSpeaking never false-guarded after TTS provider error, causing
//          permanent speaking=true deadlock. Fix: always set isSpeaking=false
//          in a try/finally inside streamTTS.
//
// BUGS FIXED (v3 — from live log analysis):
//   BUG-7 (ROOT CAUSE of post-greeting silence): Silence timer was re-armed on
//          EVERY packet once hasSpeech=true — including the 50/s energy=9 silence
//          frames that follow speech. Each silent frame reset the 900ms countdown,
//          so the timer NEVER fired. The caller could speak for 3 seconds and
//          get 150 × 900ms resets — the flush never happened.
//          Fix: only re-arm the silence timer when a speech-energy packet arrives
//          (energy >= ENERGY_THRESH). Silent frames after speech are accumulated
//          but do NOT touch the timer. Timer armed once at speech-start, then
//          only reset when MORE speech arrives (natural inter-word pauses work).
//   BUG-8: silenceEndedAt / last-speech-time tracking was absent, making it
//          impossible to enforce a true "N ms of silence after speech" window.
//          Fix: track lastSpeechAt timestamp; use it for diagnostic logging.
// ===========================================================================

const SAMPLE_RATE   = 8000;
const BYTES_PER_S   = SAMPLE_RATE * 2;       // 16 000 B/s  (linear16)
const FRAME_BYTES   = 320;                    // 20 ms @ 8 kHz

const SILENCE_MS    = parseInt(process.env.SILENCE_TIMEOUT || "900",  10);
const ENERGY_THRESH = parseInt(process.env.ENERGY_THRESH   || "80",   10); // lowered default
const MIN_SPEECH_MS = 500;
const MIN_PCM_BYTES = (MIN_SPEECH_MS / 1000) * BYTES_PER_S; // 8 000 B = 0.5 s

// Soft threshold for borderline barge-in re-queue (60 % of hard threshold)
const ENERGY_SOFT_THRESH = Math.floor(ENERGY_THRESH * 0.6);

// Cap pre-speech silence accumulation to avoid unbounded memory growth
const MAX_PRESPEECH_FRAMES = 100;   // ~2 s

// Max utterance length before forced flush (prevents infinite accumulation)
const MAX_UTT_BYTES = 30 * BYTES_PER_S; // 30 s

const KEEPALIVE_MS     = 200;
const KEEPALIVE_FRAMES = 10;

// Post-TTS drain window before re-enabling VAD (avoids TTS echo triggering STT)
const POST_TTS_DRAIN_MS = 250;

const COMPANY_CONTEXT =
  "You are a professional telecaller from Connect Ventures. " +
  "Keep every response to 1-2 short sentences. " +
  "Be warm, clear, and concise. Never repeat what the caller just said. " +
  "Do not use lists, bullet points, or special characters.";

const GREETING = "Hello, I am calling from Connect Ventures. Is this a good time to talk?";

const sessions = new Map();

// ---------------------------------------------------------------------------
// Structured logger — every log line carries a callId tag
// ---------------------------------------------------------------------------
function makeLog(callId) {
  const tag = `[${callId}]`;
  return {
    info:  (...a) => console.log(tag, ...a),
    warn:  (...a) => console.warn(tag, ...a),
    error: (...a) => console.error(tag, ...a),
    // VAD-specific with consistent prefix for easy grep
    vad:   (...a) => console.log(tag, "[VAD]", ...a),
    media: (...a) => console.log(tag, "[MEDIA]", ...a),
    tts:   (...a) => console.log(tag, "[TTS]", ...a),
    stt:   (...a) => console.log(tag, "[STT]", ...a),
    ai:    (...a) => console.log(tag, "[AI]", ...a),
    utt:   (...a) => console.log(tag, "[UTT]", ...a),
    bi:    (...a) => console.log(tag, "[BARGE-IN]", ...a),
  };
}

// ---------------------------------------------------------------------------
// VAD — linear16 s16le energy (no decode needed)
// ---------------------------------------------------------------------------
function pcmEnergy(buf) {
  if (!buf || buf.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    sum += Math.abs(buf.readInt16LE(i));
  }
  return sum / (buf.length >> 1);
}

// ---------------------------------------------------------------------------
// Env check
// ---------------------------------------------------------------------------
function checkEnv() {
  const required = ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY"];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) { console.error("Missing env vars:", missing.join(", ")); process.exit(1); }

  if (!process.env.OPENAI_API_KEY && !process.env.CAM_API_KEY) {
    console.error("No TTS provider. Set OPENAI_API_KEY or CAM_API_KEY.");
    process.exit(1);
  }

  const tts = [];
  if (process.env.OPENAI_API_KEY) tts.push("OpenAI TTS (primary)");
  if (process.env.CAM_API_KEY)    tts.push("CAMB.AI (fallback)");
  console.log("Env OK | TTS:", tts.join(" -> "));
  console.log(`Silence: ${SILENCE_MS}ms | Energy thresh: ${ENERGY_THRESH} | Soft: ${ENERGY_SOFT_THRESH} | Min speech: ${MIN_SPEECH_MS}ms`);
  console.log("IN/OUT: linear16 s16le 8kHz (Exotel native format)");
  console.log("VAD: speech-gated — silence timer only starts AFTER real speech detected");
  console.log(`Post-TTS drain: ${POST_TTS_DRAIN_MS}ms | Max utterance: ${MAX_UTT_BYTES / BYTES_PER_S}s`);
}

// ---------------------------------------------------------------------------
// Keepalive — linear16 silence frames (0x00 bytes, 320B each)
// ---------------------------------------------------------------------------
function sendSilenceFrame(ws, streamSid) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({
      event:      "media",
      stream_sid: streamSid,
      media:      { payload: Buffer.alloc(FRAME_BYTES, 0x00).toString("base64") },
    }));
  } catch (_) {}
}

function startKeepalive(ws, streamSid) {
  let total = 0;
  const iv = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { clearInterval(iv); return; }
    for (let i = 0; i < KEEPALIVE_FRAMES; i++) { sendSilenceFrame(ws, streamSid); total++; }
  }, KEEPALIVE_MS);
  return () => { clearInterval(iv); };
}

// ---------------------------------------------------------------------------
// Stream ffmpeg s16le output → Exotel (linear16 frames)
// ---------------------------------------------------------------------------
function streamL16FromFFmpeg(ff, ws, streamSid, stopKA) {
  return new Promise(resolve => {
    let rem = Buffer.alloc(0), sent = 0, stopped = false;
    const doStop = () => { if (!stopped && stopKA) { stopKA(); stopped = true; } };

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
      if (rem.length && ws?.readyState === WebSocket.OPEN) {
        const pad = Buffer.concat([rem, Buffer.alloc(FRAME_BYTES - (rem.length % FRAME_BYTES), 0x00)]);
        try {
          ws.send(JSON.stringify({ event: "media", stream_sid: streamSid, media: { payload: pad.toString("base64") } }));
          sent++;
        } catch (_) {}
      }
      if (ws?.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ event: "mark", stream_sid: streamSid, mark: { name: "tts_done" } })); } catch (_) {}
      }
      const dur = ((sent * FRAME_BYTES) / BYTES_PER_S).toFixed(1);
      console.log(`[STREAM] ${sent} l16 frames / ~${dur}s`);
      resolve();
    });

    ff.stderr.on("data", d => { const m = d.toString().trim(); if (m) console.warn("[FF]", m); });
    ff.on("error", err => { doStop(); console.error("[FF]", err.message); resolve(); });
  });
}

// Convert TTS audio buffer (mp3 or wav) → s16le 8kHz → stream to Exotel
function convertAndStream(audioBuf, inputFmt, ws, streamSid, stopKA) {
  return new Promise((res, rej) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", inputFmt, "-i", "pipe:0",
      "-ar", "8000", "-ac", "1",
      "-f", "s16le",
      "pipe:1",
    ]);
    Readable.from(audioBuf).pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    streamL16FromFFmpeg(ff, ws, streamSid, stopKA).then(res).catch(rej);
  });
}

// ---------------------------------------------------------------------------
// TTS providers
// ---------------------------------------------------------------------------
async function ttsViaOpenAI(text, ws, streamSid, stopKA) {
  if (!process.env.OPENAI_API_KEY) throw new Error("no OPENAI_API_KEY");
  const voice = process.env.OPENAI_VOICE || "nova";
  console.log(`[TTS/OAI] voice=${voice} ->`, text.slice(0, 60));

  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "mp3", "-i", "pipe:0",
    "-ar", "8000", "-ac", "1",
    "-f", "s16le",
    "pipe:1",
  ]);
  const done = streamL16FromFFmpeg(ff, ws, streamSid, stopKA);

  const response = await axios({
    method:       "post",
    url:          "https://api.openai.com/v1/audio/speech",
    data:         { model: "tts-1", input: text, voice, response_format: "mp3", speed: 1.0 },
    headers:      { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    responseType: "stream",
    timeout:      20000,
  });

  response.data.pipe(ff.stdin);
  response.data.on("error", e => { console.warn("[TTS/OAI] stream err:", e.message); ff.stdin.end(); });
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
      language:       "en-in",
      voice_id:       parseInt(process.env.CAMB_VOICE_ID || "147320", 10),
      speech_model:   "mars-flash",
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

// ---------------------------------------------------------------------------
// streamTTS — FIX: always reset isSpeaking in try/finally to prevent deadlock
//             FIX: wipe audioChunks + VAD state at entry (BUG-1)
//             FIX: robust barge-in handling — fold soft audio back into VAD (BUG-2)
// ---------------------------------------------------------------------------
async function streamTTS(text, ws, streamSid, session) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !streamSid) {
    session?.log?.tts("skip — ws not ready");
    return;
  }
  const log = session?.log || { tts: console.log, bi: console.log, vad: console.log, warn: console.warn, error: console.error };

  log.tts(`start | "${text.slice(0, 80)}"`);

  // -------------------------------------------------------------------------
  // BUG-1 FIX: Clear ALL stale VAD state BEFORE setting isSpeaking=true.
  // Without this, audioChunks accumulated during silence before the greeting
  // remains, and the energy of that silence block pollutes the NEXT utterance.
  // -------------------------------------------------------------------------
  clearTimeout(session.silenceTimer);
  session.silenceTimer    = null;
  session.audioChunks     = [];
  session.hasSpeech       = false;
  session.speechEnergy    = 0;
  session.lastSpeechAt    = 0;
  session.bargeinChunks   = [];   // start fresh barge-in collection

  session.isSpeaking      = true;

  const stopKA = startKeepalive(ws, streamSid);
  let ok = false;

  try {
    for (const [name, key, fn] of [
      ["OpenAI",  "OPENAI_API_KEY", () => ttsViaOpenAI(text, ws, streamSid, stopKA)],
      ["CAMB.AI", "CAM_API_KEY",    () => ttsViaCamb(text, ws, streamSid, stopKA)],
    ]) {
      if (!process.env[key]) continue;
      try {
        await fn();
        ok = true;
        log.tts(`done via ${name}`);
        break;
      } catch (e) {
        log.warn(`TTS ${name} failed: ${e.message.slice(0, 120)}`);
      }
    }
    if (!ok) log.error("all TTS providers failed");
  } finally {
    // -----------------------------------------------------------------------
    // BUG-6 FIX: isSpeaking MUST be cleared in finally so a TTS crash cannot
    // leave the session permanently stuck in speaking=true (deadlock state).
    // -----------------------------------------------------------------------
    stopKA();
    session.isSpeaking = false;
    log.tts(`isSpeaking=false | bargeinChunks=${session.bargeinChunks.length}`);
  }

  // -------------------------------------------------------------------------
  // Post-TTS drain window — wait briefly before re-enabling VAD so any
  // keepalive/echo frames from the telephony bridge don't trip speech detection.
  // -------------------------------------------------------------------------
  await new Promise(r => setTimeout(r, POST_TTS_DRAIN_MS));

  // -------------------------------------------------------------------------
  // BUG-2 FIX: Process barge-in audio collected during TTS playback.
  //
  // OLD behaviour: if energy < ENERGY_THRESH → bargeinChunks silently dropped.
  //   This caused any soft or early speech during the greeting to vanish.
  //
  // NEW behaviour:
  //   • Strong speech (energy >= ENERGY_THRESH)         → processUtterance immediately
  //   • Borderline speech (energy >= ENERGY_SOFT_THRESH) → fold into audioChunks + arm timer
  //   • Noise (energy < ENERGY_SOFT_THRESH)              → discard (logged)
  // -------------------------------------------------------------------------
  if (session.bargeinChunks.length > 0) {
    const bargein         = Buffer.concat(session.bargeinChunks);
    session.bargeinChunks = [];
    const energy          = pcmEnergy(bargein);
    const seconds         = (bargein.length / BYTES_PER_S).toFixed(2);
    log.bi(`post-TTS | ${bargein.length}B | ${seconds}s | energy=${energy.toFixed(0)} | thresh=${ENERGY_THRESH} | soft=${ENERGY_SOFT_THRESH}`);

    if (!session.isProcessing && bargein.length >= MIN_PCM_BYTES && energy >= ENERGY_THRESH) {
      log.bi("strong speech — processing immediately");
      processUtterance(bargein, session, ws).catch(e => log.error("barge-in processUtterance:", e.message));

    } else if (bargein.length >= MIN_PCM_BYTES && energy >= ENERGY_SOFT_THRESH) {
      // Borderline: fold back into accumulator and arm silence timer so the
      // user can continue speaking and the full utterance gets captured.
      log.bi(`borderline energy — folding ${bargein.length}B back into audioChunks`);
      session.audioChunks = [bargein, ...session.audioChunks];
      session.hasSpeech   = true;
      clearTimeout(session.silenceTimer);
      session.silenceTimer = setTimeout(
        () => flushAudioForSession(session, ws, "barge-in-requeue"),
        SILENCE_MS
      );

    } else {
      log.bi(`discarding — too short or too quiet (energy=${energy.toFixed(0)} < soft-thresh=${ENERGY_SOFT_THRESH})`);
    }
  }
}

// ---------------------------------------------------------------------------
// STT — raw linear16 directly to Deepgram (no decode, no conversion)
// ---------------------------------------------------------------------------
async function speechToText(pcmBuf, log) {
  const energy  = pcmEnergy(pcmBuf).toFixed(0);
  const seconds = (pcmBuf.length / BYTES_PER_S).toFixed(2);
  log.stt(`sending ${pcmBuf.length}B (${seconds}s) energy=${energy} to Deepgram`);

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
    log.stt(`result: "${text}" (conf=${(alt?.confidence || 0).toFixed(2)})`);
    return text;
  } catch (e) {
    log.error("STT error:", e?.response?.status, e.message);
    return "";
  }
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------
async function getAIResponse(history, text, log) {
  history.push({ role: "user", content: text });
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system:     COMPANY_CONTEXT,
        messages:   history,
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
    log.ai(`"${reply}"`);
    return reply;
  } catch (e) {
    log.error("AI error:", e?.response?.status, e?.response?.data || e.message);
    return "I'm sorry, could you say that again?";
  }
}

// ---------------------------------------------------------------------------
// processUtterance — STT → LLM → TTS pipeline
//
// BUG-3 FIX: pendingFlush finally block now correctly snapshots deferred audio
//            without losing packets that arrived during processing.
// ---------------------------------------------------------------------------
async function processUtterance(pcmBuf, session, ws) {
  if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) {
    session.log.utt("ws closed — aborting");
    return;
  }
  const t0 = Date.now();
  session.isProcessing = true;
  const log = session.log;
  log.utt(`start | ${pcmBuf.length}B (${(pcmBuf.length / BYTES_PER_S).toFixed(2)}s)`);

  try {
    const transcript = await speechToText(pcmBuf, log);
    if (!transcript || transcript.trim().length < 2) {
      log.utt("empty transcript — skip");
      return;
    }
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) return;

    const reply = await getAIResponse(session.history, transcript, log);
    if (!session.wsOpen || ws.readyState !== WebSocket.OPEN) return;

    log.utt(`STT+AI in ${Date.now() - t0}ms`);
    await streamTTS(reply, ws, session.streamSid, session);
    log.utt(`total round-trip ${Date.now() - t0}ms`);

  } catch (e) {
    log.error("processUtterance:", e.message);
  } finally {
    session.isProcessing = false;
    log.utt(`pipeline free | pendingFlush=${session.pendingFlush} | buffered chunks=${session.audioChunks.length}`);

    if (session.pendingFlush) {
      session.pendingFlush = false;

      // -------------------------------------------------------------------
      // BUG-3 FIX: The original code did:
      //   session.audioChunks = [pcm]   (in flushAudio when busy)
      //   ...new packets arrive and are pushed to session.audioChunks...
      //   finally: concat(session.audioChunks) → clears ALL including new ones
      //
      // This is correct behaviour — we WANT all buffered audio (the deferred
      // pcm + any new packets that arrived since). The concat is safe.
      // What was NOT safe was that the old finally block had:
      //   const pending = Buffer.concat(session.audioChunks);
      //   session.audioChunks = [];   ← this cleared new packets too, then
      //                                  only the pending var was used.
      // That's actually fine... BUT the bug was that it didn't re-check
      // hasSpeech or reset VAD state, so subsequent turns had stale flags.
      // -------------------------------------------------------------------
      if (session.audioChunks.length > 0) {
        const deferred      = Buffer.concat(session.audioChunks);
        session.audioChunks = [];
        // Reset VAD latch — this is a fresh evaluation of the deferred audio
        session.hasSpeech    = false;
        session.speechEnergy = 0;
        session.lastSpeechAt = 0;

        const energy = pcmEnergy(deferred);
        log.utt(`draining deferred | ${deferred.length}B | energy=${energy.toFixed(0)}`);

        if (deferred.length >= MIN_PCM_BYTES && energy >= ENERGY_THRESH) {
          await processUtterance(deferred, session, ws);
        } else {
          log.utt(`deferred audio below threshold (energy=${energy.toFixed(0)} thresh=${ENERGY_THRESH}) — skip`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// flushAudio — extracted as a standalone function so it can be called from
// both the closure inside wss.on("connection") and from streamTTS barge-in.
//
// BUG-4 FIX: capture hadSpeech before reset; always clearTimeout at entry.
// ---------------------------------------------------------------------------
function flushAudioForSession(session, ws, trigger) {
  const log = session.log;

  // BUG-4 FIX: cancel timer unconditionally — prevents double-fire if a new
  // media packet races against a scheduled timeout.
  clearTimeout(session.silenceTimer);
  session.silenceTimer = null;

  // Capture latch state BEFORE reset so we can log and gate correctly.
  const hadSpeech      = session.hasSpeech;
  session.hasSpeech    = false;
  session.speechEnergy = 0;
  session.lastSpeechAt = 0;

  if (session.audioChunks.length === 0) {
    log.vad(`flush(${trigger}) — buffer empty, skip`);
    return;
  }

  // Snapshot + clear atomically: incoming packets will now start a fresh buffer
  const pcm           = Buffer.concat(session.audioChunks);
  session.audioChunks = [];

  const energy  = pcmEnergy(pcm);
  const seconds = (pcm.length / BYTES_PER_S).toFixed(2);
  log.vad(`flush(${trigger}) | ${pcm.length}B | ${seconds}s | energy=${energy.toFixed(0)} | hadSpeech=${hadSpeech}`);

  if (!hadSpeech) {
    log.vad("hasSpeech never latched — pure silence block, skip STT");
    return;
  }
  if (pcm.length < MIN_PCM_BYTES) {
    log.vad(`too short: ${pcm.length}B < min ${MIN_PCM_BYTES}B — skip`);
    return;
  }
  if (energy < ENERGY_THRESH) {
    log.vad(`energy ${energy.toFixed(0)} < thresh ${ENERGY_THRESH} — skip`);
    return;
  }
  if (session.isProcessing) {
    log.vad(`pipeline busy — deferring ${pcm.length}B`);
    // Put audio back so processUtterance finally-block can pick it up.
    // Prepend so any new chunks that arrive go AFTER this deferred block.
    session.audioChunks  = [pcm, ...session.audioChunks];
    session.pendingFlush = true;
    return;
  }

  processUtterance(pcm, session, ws).catch(e => log.error("flushAudio processUtterance:", e.message));
}

// ---------------------------------------------------------------------------
// WebSocket connection handler
// ---------------------------------------------------------------------------
wss.on("connection", (ws, req) => {
  const callId   = Math.random().toString(36).slice(2, 8);
  const clientIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const log      = makeLog(callId);
  log.info(`New call | ${clientIP}`);

  // -------------------------------------------------------------------------
  // Session state — all flags documented with their lifecycle
  // -------------------------------------------------------------------------
  const session = {
    callId,
    log,
    history:        [],
    streamSid:      null,

    // Audio accumulation
    audioChunks:    [],   // frames accumulating for current utterance (VAD path)
    bargeinChunks:  [],   // frames received while isSpeaking === true

    // Pipeline state
    isProcessing:   false,  // true: STT→LLM→TTS is running
    isSpeaking:     false,  // true: TTS audio is being streamed out
    pendingFlush:   false,  // true: a flush was requested while isProcessing

    // VAD state
    hasSpeech:      false,  // latched true once a frame >= ENERGY_THRESH seen
    speechEnergy:   0,      // running max energy seen in this utterance
    lastSpeechAt:   0,      // Date.now() of last speech-energy packet (for diagnostics)
    silenceTimer:   null,

    // Lifecycle
    greetingSent:   false,
    wsOpen:         true,
    pktCount:       0,
  };
  sessions.set(callId, session);

  // -------------------------------------------------------------------------
  // maybeGreet — fire exactly once when streamSid is known
  // -------------------------------------------------------------------------
  function maybeGreet() {
    if (session.greetingSent || !session.streamSid) return;
    session.greetingSent = true;
    session.history.push({ role: "assistant", content: GREETING });
    log.info("firing greeting TTS");
    streamTTS(GREETING, ws, session.streamSid, session).catch(e => {
      log.error("greeting TTS:", e.message);
      // Ensure isSpeaking is always cleared even if streamTTS's own finally
      // somehow fails (belt-and-suspenders).
      session.isSpeaking = false;
    });
  }

  // -------------------------------------------------------------------------
  // WebSocket message handler
  // -------------------------------------------------------------------------
  ws.on("message", async rawMsg => {
    let data;
    try { data = JSON.parse(rawMsg); } catch (_) { return; }

    // -----------------------------------------------------------------------
    if (data.event === "connected") {
      log.info("Exotel connected");
    }

    // -----------------------------------------------------------------------
    if (data.event === "start") {
      const sid = data.stream_sid
        || data.streamSid
        || data.start?.stream_sid
        || data.start?.streamSid
        || null;
      if (sid) session.streamSid = sid;
      log.info(`start | streamSid=${session.streamSid}`);
      maybeGreet();
    }

    // -----------------------------------------------------------------------
    // "media" handler — the hot path for every 20 ms audio frame
    // -----------------------------------------------------------------------
    if (data.event === "media") {
      const rawBytes = Buffer.from(data.media.payload, "base64");
      session.pktCount++;

      // Recover streamSid if we missed the "start" event (some bridges omit it)
      if (!session.streamSid) {
        const sid = data.stream_sid || data.media?.stream_sid || null;
        if (sid) {
          session.streamSid = sid;
          log.info(`streamSid recovered from media: ${session.streamSid}`);
        }
      }
      if (!session.greetingSent && session.streamSid) maybeGreet();

      const energy = pcmEnergy(rawBytes);

      // Diagnostic logs — first packet, first 20, then every 100
      if (session.pktCount === 1) {
        log.media(`FIRST pkt | ${rawBytes.length}B | energy=${energy.toFixed(0)} | hex=${rawBytes.slice(0, 16).toString("hex")}`);
      }
      if (session.pktCount <= 20 || session.pktCount % 100 === 0) {
        log.media(`pkt#${session.pktCount} | energy=${energy.toFixed(0)} | speaking=${session.isSpeaking} | hasSpeech=${session.hasSpeech} | processing=${session.isProcessing}`);
      }

      // ---------------------------------------------------------------------
      // PATH A — Bot is currently speaking (TTS streaming)
      //   Buffer ALL audio for potential barge-in. Do not touch audioChunks
      //   or the silence timer — those are reset at TTS entry (BUG-1 fix).
      // ---------------------------------------------------------------------
      if (session.isSpeaking) {
        session.bargeinChunks.push(rawBytes);
        if (energy >= ENERGY_THRESH) {
          log.bi(`speech during TTS | energy=${energy.toFixed(0)} | pkt#${session.pktCount}`);
        }
        return; // ← explicit early return: no VAD processing while bot speaks
      }

      // ---------------------------------------------------------------------
      // PATH B — Bot is silent, accumulate and run VAD
      // ---------------------------------------------------------------------
      session.audioChunks.push(rawBytes);

      if (energy >= ENERGY_THRESH) {
        if (!session.hasSpeech) {
          log.vad(`speech START | energy=${energy.toFixed(0)} | pkt#${session.pktCount} | accumulated=${session.audioChunks.length} chunks`);
        }
        session.hasSpeech    = true;
        session.speechEnergy = Math.max(session.speechEnergy, energy);
        session.lastSpeechAt = Date.now();

        // -----------------------------------------------------------------
        // BUG-7 FIX: Re-arm the silence timer ONLY on speech-energy packets.
        //
        // BEFORE (broken): timer was reset inside `if (session.hasSpeech)`,
        // which ran on EVERY packet — including the 50 silent frames/sec
        // that follow speech (energy=9). Each silent frame postponed the
        // 900ms countdown indefinitely → flushAudio() NEVER fired.
        //
        // AFTER (correct): timer is reset only here, inside the energy>=THRESH
        // branch. Silent frames after speech do NOT touch the timer.
        // The timer armed on the last speech-energy frame counts down cleanly
        // through subsequent silence and fires exactly SILENCE_MS after the
        // caller stopped speaking.
        // -----------------------------------------------------------------
        clearTimeout(session.silenceTimer);
        session.silenceTimer = setTimeout(
          () => flushAudioForSession(session, ws, "silence-timer"),
          SILENCE_MS
        );
      }

      if (session.hasSpeech) {
        // Guard: max utterance length — force flush to prevent runaway buffer
        const accumulated = session.audioChunks.reduce((s, c) => s + c.length, 0);
        if (accumulated >= MAX_UTT_BYTES) {
          const silentMs = session.lastSpeechAt ? Date.now() - session.lastSpeechAt : 0;
          log.vad(`max utterance reached (${accumulated}B >= ${MAX_UTT_BYTES}B) | silent for ${silentMs}ms — forcing flush`);
          flushAudioForSession(session, ws, "max-utterance");
        }
      } else {
        // BUG-5 FIX: Cap pre-speech silence accumulation.
        // Without this, several seconds of silence before the caller first
        // speaks fills audioChunks, and when speech finally starts the old
        // silence frames are included in the flush — this dilutes the energy
        // average and can cause legitimate speech to fail the threshold check.
        if (session.audioChunks.length > MAX_PRESPEECH_FRAMES) {
          session.audioChunks = session.audioChunks.slice(-MAX_PRESPEECH_FRAMES);
        }
      }
    }

    // -----------------------------------------------------------------------
    if (data.event === "stop") {
      clearTimeout(session.silenceTimer);
      log.info(`stop | pkts=${session.pktCount}`);
      flushAudioForSession(session, ws, "stop-event");
    }

    if (data.event === "mark") {
      log.info("mark:", data.mark?.name || data.mark);
    }
  });

  // -------------------------------------------------------------------------
  ws.on("close", code => {
    session.wsOpen = false;
    clearTimeout(session.silenceTimer);
    log.info(`closed | code=${code} | pkts=${session.pktCount}`);
    sessions.delete(callId);
  });

  ws.on("error", err => {
    session.wsOpen = false;
    log.error("ws error:", err.message);
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  const tts = [];
  if (process.env.OPENAI_API_KEY) tts.push("OpenAI");
  if (process.env.CAM_API_KEY)    tts.push("CAMB.AI");
  res.json({
    status:          "ok",
    sessions:        sessions.size,
    uptime:          Math.floor(process.uptime()),
    tts,
    energy_thresh:   ENERGY_THRESH,
    energy_soft:     ENERGY_SOFT_THRESH,
    format:          "linear16 s16le 8kHz in/out",
    vad:             "speech-gated silence timer v2",
    post_tts_drain:  POST_TTS_DRAIN_MS,
  });
});

checkEnv();
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
