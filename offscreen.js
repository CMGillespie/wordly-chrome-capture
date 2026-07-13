// offscreen.js — Wordly Capture v0.2.1
// Runs in an offscreen document (has access to getUserMedia)
// Captures tab audio, resamples to 16kHz mono PCM, sends chunks to background
// Also plays audio locally via an audio element (volume controllable)

let audioCtx   = null;
let source     = null;
let processor  = null;
let stream     = null;
let audioEl    = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "OFFSCREEN_START") {
    startCapture(msg.streamId, msg.sampleRate, msg.chunkFrames);
  }
  if (msg.type === "OFFSCREEN_STOP") {
    stopCapture();
  }
  if (msg.type === "SET_SOURCE_VOLUME") {
    if (audioEl) audioEl.volume = Math.max(0, Math.min(1, msg.volume));
  }
});

async function startCapture(streamId, targetSampleRate, chunkFrames) {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        }
      },
      video: false,
    });

    // Play audio locally — volume controllable, does NOT affect Wordly stream
    audioEl = document.createElement("audio");
    audioEl.srcObject = stream;
    audioEl.volume = 1.0;
    document.body.appendChild(audioEl);
    audioEl.play().catch(e => console.warn("Local playback failed:", e));

    // Audio pipeline for Wordly stream (unaffected by audioEl volume)
    audioCtx = new AudioContext();
    const nativeSampleRate = audioCtx.sampleRate;
    source = audioCtx.createMediaStreamSource(stream);

    const bufferSize = Math.max(256, Math.pow(2, Math.ceil(
      Math.log2(chunkFrames * nativeSampleRate / targetSampleRate)
    )));

    processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);

    let pcmBuffer = new Float32Array(0);
    const targetChunkSize = chunkFrames;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const resampled = resample(input, nativeSampleRate, targetSampleRate);
      const combined = new Float32Array(pcmBuffer.length + resampled.length);
      combined.set(pcmBuffer);
      combined.set(resampled, pcmBuffer.length);
      pcmBuffer = combined;
      while (pcmBuffer.length >= targetChunkSize) {
        const chunk = pcmBuffer.slice(0, targetChunkSize);
        pcmBuffer = pcmBuffer.slice(targetChunkSize);
        sendChunk(chunk);
      }
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);

  } catch(e) {
    console.error("Offscreen capture error:", e);
    chrome.runtime.sendMessage({ type: "CAPTURE_ERROR", error: e.message });
  }
}

function stopCapture() {
  if (processor) { processor.disconnect(); processor = null; }
  if (source)    { source.disconnect();    source    = null; }
  if (audioCtx)  { audioCtx.close();       audioCtx  = null; }
  if (audioEl)   { audioEl.srcObject = null; audioEl.remove(); audioEl = null; }
  if (stream)    { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

function resample(input, srcRate, dstRate) {
  if (srcRate === dstRate) return input;
  const ratio  = srcRate / dstRate;
  const outLen = Math.floor(input.length / ratio);
  const output = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos  = i * ratio;
    const idx  = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx]     ?? 0;
    const b = input[idx + 1] ?? 0;
    output[i] = a + frac * (b - a);
  }
  return output;
}

function sendChunk(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  chrome.runtime.sendMessage({ type: "AUDIO_CHUNK", buffer: btoa(binary) });
}
