"require(\"dotenv\").config();
const express = require(\"express\");
const http = require(\"http\");
const WebSocket = require(\"ws\");
const axios = require(\"axios\");
const { spawn } = require(\"child_process\");
const ffmpegPath = require(\"ffmpeg-static\");
const fs = require(\"fs\");
const path = require(\"path\");
const os = require(\"os\");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 5000;

console.log(\"=== VOICE AGENT STARTUP ===\");
console.log(\"ANTHROPIC_API_KEY :\", process.env.ANTHROPIC_API_KEY ? \"✅ SET\" : \"❌ MISSING\");
console.log(\"DEEPGRAM_API_KEY :\", process.env.DEEPGRAM_API_KEY ? \"✅ SET\" : \"❌ MISSING\");
console.log(\"ELEVENLABS_API_KEY :\", process.env.ELEVENLABS_API_KEY ? \"✅ SET\" : \"❌ MISSING\");
console.log(\"ELEVENLABS_VOICE_ID:\", process.env.ELEVENLABS_VOICE_ID ? \"✅ \" + process.env.ELEVENLABS_VOICE_ID : \"❌ MISSING\");
console.log(\"PORT :\", PORT);
console.log(\"===========================
\");

const sessions = {};

const COMPANY_CONTEXT = `You are a professional telecaller from Connect Ventures Services Pvt Ltd. 
Keep responses very short (1-2 sentences max). Ask one clear question at a time. 
Be friendly, natural and conversational. No pricing details, no legal advice.`;

const GREETING = \"Hello, I am calling from Connect Ventures. Is this a good time to talk?\";

// Exotel uses 8kHz mulaw - 160 bytes = 20ms of audio
const MULAW_FRAME_BYTES = 160;
const FRAME_INTERVAL_MS = 20;

// ═══════════════════════════════════════════════════════════════════════════════
// MULAW ENCODING - Pure JavaScript (100% reliable)
// ═══════════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO CONVERSION: MP3 → PCM → MULAW (Guaranteed to work)
// ═══════════════════════════════════════════════════════════════════════════════
async function convertToMulaw(mp3Buffer) {
  const tmpMp3 = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);
  const tmpPcm = path.join(os.tmpdir(), `pcm_${Date.now()}.raw`);

  try {
    // Step 1: Write MP3 to temp file
    fs.writeFileSync(tmpMp3, mp3Buffer);
    console.log(`[AUDIO] Step 1: Wrote ${mp3Buffer.length}B MP3`);

    // Step 2: Convert MP3 to PCM using FFmpeg
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        \"-y\",
        \"-i\", tmpMp3,
        \"-ar\", \"8000\",           // 8kHz sample rate
        \"-ac\", \"1\",              // mono
        \"-f\", \"s16le\",           // signed 16-bit little-endian PCM
        \"-acodec\", \"pcm_s16le\",  // explicit PCM codec
        tmpPcm
      ]);

      let errors = \"\";
      ffmpeg.stderr.on(\"data\", d => errors += d.toString());
      
      ffmpeg.on(\"close\", code => {
        if (code === 0 && fs.existsSync(tmpPcm)) {
          const pcmSize = fs.statSync(tmpPcm).size;
          console.log(`[AUDIO] Step 2: FFmpeg converted to ${pcmSize}B PCM`);
          resolve();
        } else {
          console.error(`[AUDIO] FFmpeg failed (code ${code}):`, errors.slice(-300));
          reject(new Error(`FFmpeg conversion failed`));
        }
      });
      
      ffmpeg.on(\"error\", err => reject(err));
    });

    // Step 3: Read PCM data
    const pcmData = fs.readFileSync(tmpPcm);
    console.log(`[AUDIO] Step 3: Read ${pcmData.length}B PCM from disk`);

    if (pcmData.length < 1000) {
      throw new Error(`PCM file too small: ${pcmData.length}B - conversion failed!`);
    }

    // Step 4: Encode PCM to mulaw using JavaScript
    const mulawData = pcm16ToMulaw(pcmData);
    const ratio = (mulawData.length / mp3Buffer.length).toFixed(2);
    
    console.log(`[AUDIO] Step 4: ✅ CONVERSION COMPLETE`);
    console.log(`[AUDIO]   - Input MP3:  ${mp3Buffer.length}B`);
    console.log(`[AUDIO]   - Output PCM: ${pcmData.length}B`);
    console.log(`[AUDIO]   - Final mulaw: ${mulawData.length}B`);
    console.log(`[AUDIO]   - Ratio: ${ratio}x ${ratio < 0.7 ? '✅ GOOD' : '⚠️ CHECK THIS'}`);

    // Validation check
    if (ratio > 0.9) {
      console.error(`[AUDIO] ❌ ERROR: Ratio too high (${ratio}x) - mulaw encoding may have failed!`);
      throw new Error(`Invalid mulaw conversion - ratio ${ratio}x`);
    }

    return mulawData;

  } catch (error) {
    console.error(`[AUDIO] ❌ Conversion error:`, error.message);
    throw error;
  } finally {
    // Cleanup temp files
    try { fs.unlinkSync(tmpMp3); } catch {}
    try { fs.unlinkSync(tmpPcm); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEXT-TO-SPEECH: ElevenLabs + Google Fallback
// ═══════════════════════════════════════════════════════════════════════════════
async function textToSpeech(text) {
  // Try ElevenLabs first
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
    try {
      console.log(`[TTS] Trying ElevenLabs...`);
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
        {
          text: text,
          model_id: \"eleven_turbo_v2\",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        },
        {
          headers: {
            \"xi-api-key\": process.env.ELEVENLABS_API_KEY,
            \"Content-Type\": \"application/json\"
          },
          responseType: \"arraybuffer\",
          timeout: 15000
        }
      );

      const mp3 = Buffer.from(response.data);
      console.log(`[TTS] ✅ ElevenLabs: Got ${mp3.length}B MP3`);
      return mp3;

    } catch (error) {
      console.error(`[TTS] ❌ ElevenLabs failed:`, error.response?.status, error.message);
      console.log(`[TTS] Falling back to Google TTS...`);
    }
  }

  // Fallback to Google TTS
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en-IN&client=tw-ob`;
    const response = await axios.get(url, {
      responseType: \"arraybuffer\",
      timeout: 10000,
      headers: {
        \"User-Agent\": \"Mozilla/5.0\",
        \"Referer\": \"https://translate.google.com/\"
      }
    });

    const mp3 = Buffer.from(response.data);
    console.log(`[TTS] ✅ Google TTS: Got ${mp3.length}B MP3`);
    return mp3;

  } catch (error) {
    console.error(`[TTS] ❌ Google TTS failed:`, error.message);
    throw new Error(\"All TTS services failed\");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPEECH-TO-TEXT: Deepgram
// ═══════════════════════════════════════════════════════════════════════════════
async function speechToText(audioBuffer) {
  console.log(`[STT] Sending ${audioBuffer.length}B to Deepgram...`);
  
  try {
    const response = await axios.post(
      \"https://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&language=en-IN&punctuate=true&model=nova-2\",
      audioBuffer,
      {
        headers: {
          \"Authorization\": `Token ${process.env.DEEPGRAM_API_KEY}`,
          \"Content-Type\": \"application/octet-stream\"
        },
        timeout: 15000
      }
    );

    const transcript = response.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || \"\";
    const confidence = response.data?.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0;
    
    console.log(`[STT] ✅ Transcript (${(confidence * 100).toFixed(0)}%): \"${transcript}\"`);
    return transcript;

  } catch (error) {
    console.error(`[STT] ❌ Error:`, error.message);
    return \"\";
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI RESPONSE: Anthropic Claude
// ═══════════════════════════════════════════════════════════════════════════════
async function getAIResponse(callId, userText) {
  const session = sessions[callId];
  session.history.push({ role: \"user\", content: userText });

  try {
    const response = await axios.post(
      \"https://api.anthropic.com/v1/messages\",
      {
        model: \"claude-haiku-4-5-20251001\",
        max_tokens: 150,
        system: COMPANY_CONTEXT,
        messages: session.history
      },
      {
        headers: {
          \"x-api-key\": process.env.ANTHROPIC_API_KEY,
          \"anthropic-version\": \"2023-06-01\",
          \"content-type\": \"application/json\"
        },
        timeout: 15000
      }
    );

    const reply = response.data.content[0].text.trim();
    session.history.push({ role: \"assistant\", content: reply });
    console.log(`[AI] ✅ Reply: \"${reply}\"`);
    return reply;

  } catch (error) {
    console.error(`[AI] ❌ Error:`, error.message);
    return \"Could you please repeat that?\";
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEND AUDIO TO EXOTEL
// ═══════════════════════════════════════════════════════════════════════════════
async function sendAudioToExotel(ws, streamSid, text) {
  console.log(`
[SEND] ═══════════════════════════════════════`);
  console.log(`[SEND] Text: \"${text}\"`);
  console.log(`[SEND] StreamSID: ${streamSid}`);
  
  try {
    // Get MP3 from TTS
    const mp3 = await textToSpeech(text);
    
    // Convert to mulaw
    const mulawBuffer = await convertToMulaw(mp3);

    // Pad to frame boundary
    const remainder = mulawBuffer.length % MULAW_FRAME_BYTES;
    const paddedMulaw = remainder === 0
      ? mulawBuffer
      : Buffer.concat([mulawBuffer, Buffer.alloc(MULAW_FRAME_BYTES - remainder, 0xFF)]);

    const totalFrames = Math.ceil(paddedMulaw.length / MULAW_FRAME_BYTES);
    console.log(`[SEND] Streaming ${paddedMulaw.length}B in ${totalFrames} frames...`);

    // Send frames
    let sentFrames = 0;
    for (let i = 0; i < paddedMulaw.length; i += MULAW_FRAME_BYTES) {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log(`[SEND] ⚠️  WebSocket closed at frame ${sentFrames}`);
        break;
      }

      const frame = paddedMulaw.slice(i, i + MULAW_FRAME_BYTES);
      
      ws.send(JSON.stringify({
        event: \"media\",
        stream_sid: streamSid,
        media: {
          payload: frame.toString(\"base64\")
        }
      }));

      sentFrames++;
      await new Promise(resolve => setTimeout(resolve, FRAME_INTERVAL_MS));
    }

    // Send completion mark
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: \"mark\",
        stream_sid: streamSid,
        mark: { name: \"done\" }
      }));
    }

    console.log(`[SEND] ✅ SENT ${sentFrames} frames successfully`);
    console.log(`[SEND] ═══════════════════════════════════════
`);

  } catch (error) {
    console.error(`[SEND] ❌ ERROR:`, error.message);
    console.error(error.stack);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
wss.on(\"connection\", (ws, req) => {
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  console.log(`
🔵 NEW CALL | ID: ${callId}`);

  sessions[callId] = {
    history: [],
    streamSid: null,
    audioChunks: [],
    silenceTimer: null,
    isProcessing: false,
    greetingSent: false
  };

  ws.on(\"message\", async (message) => {
    const session = sessions[callId];
    if (!session) return;

    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      return;
    }

    console.log(`[WS] Event: ${data.event}`);

    switch (data.event) {
      case \"connected\":
        console.log(`[WS] ✅ Connected`);
        break;

      case \"start\":
        session.streamSid = data.stream_sid || data.start?.stream_sid;
        console.log(`[WS] ✅ Started | StreamSID: ${session.streamSid}`);

        // SEND GREETING
        if (!session.greetingSent) {
          session.greetingSent = true;
          console.log(`[WS] 📞 Sending greeting...`);
          await sendAudioToExotel(ws, session.streamSid, GREETING);
          session.history.push({ role: \"assistant\", content: GREETING });
        }
        break;

      case \"media\":
        if (!session.streamSid) {
          session.streamSid = data.stream_sid || `temp_${callId}`;
        }

        // Send greeting if not sent
        if (!session.greetingSent) {
          session.greetingSent = true;
          sendAudioToExotel(ws, session.streamSid, GREETING).then(() => {
            session.history.push({ role: \"assistant\", content: GREETING });
          });
          return;
        }

        // Don't process if already processing
        if (session.isProcessing) return;

        // Collect audio
        session.audioChunks.push(Buffer.from(data.media.payload, \"base64\"));

        // Reset silence timer
        if (session.silenceTimer) clearTimeout(session.silenceTimer);

        session.silenceTimer = setTimeout(async () => {
          if (session.audioChunks.length === 0 || session.isProcessing) return;

          session.isProcessing = true;
          const audio = Buffer.concat(session.audioChunks);
          session.audioChunks = [];

          console.log(`
[VOICE] User spoke ${audio.length}B`);

          if (audio.length < 1000) {
            console.log(`[VOICE] Too short, ignoring`);
            session.isProcessing = false;
            return;
          }

          // Transcribe
          const transcript = await speechToText(audio);
          if (!transcript || transcript.length < 2) {
            console.log(`[VOICE] No transcript`);
            session.isProcessing = false;
            return;
          }

          console.log(`[VOICE] User said: \"${transcript}\"`);

          // Get AI reply
          const reply = await getAIResponse(callId, transcript);

          // Send audio response
          await sendAudioToExotel(ws, session.streamSid, reply);

          session.isProcessing = false;
        }, 1500);

        break;

      case \"stop\":
        console.log(`[WS] 🔴 Call ended`);
        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        break;
    }
  });

  ws.on(\"close\", () => {
    console.log(`
🔴 CALL ENDED | ID: ${callId}
`);
    if (sessions[callId]?.silenceTimer) {
      clearTimeout(sessions[callId].silenceTimer);
    }
    delete sessions[callId];
  });

  ws.on(\"error\", (error) => {
    console.error(`[WS] Error:`, error.message);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get(\"/\", (req, res) => {
  res.json({
    status: \"running\",
    service: \"Connect Ventures Voice Agent\",
    active_calls: Object.keys(sessions).length,
    uptime: Math.floor(process.uptime())
  });
});

app.get(\"/health\", (req, res) => {
  res.json({ status: \"healthy\" });
});

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`
${\"═\".repeat(50)}`);
  console.log(`🚀 VOICE AGENT RUNNING`);
  console.log(`📞 Port: ${PORT}`);
  console.log(`🌐 WebSocket: ws://localhost:${PORT}`);
  console.log(`${\"═\".repeat(50)}
`);
});
"
