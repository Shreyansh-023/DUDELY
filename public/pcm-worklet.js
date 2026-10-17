/**
 * Mic → 16 kHz mono linear16 PCM, for streaming speech-to-text.
 *
 * Streaming ASR endpoints (Sarvam realtime, OpenAI realtime, Deepgram…) all want
 * raw little-endian 16-bit PCM at 8 or 16 kHz, in small chunks, continuously —
 * not the webm/opus container MediaRecorder produces. The browser's AudioContext
 * runs at whatever the device likes (usually 48000, sometimes 44100), so this
 * processor resamples to a fixed target rate and emits fixed-size chunks.
 *
 * Resampling is linear interpolation over a fractional read head that carries
 * across render quanta (128 frames), so there is no click at block boundaries
 * and non-integer ratios (44100/16000 = 2.75625) work. Speech lives well below
 * 8 kHz, so no anti-alias filter beyond the interpolation is needed in practice.
 *
 * Each message to the main thread is an ArrayBuffer of Int16 samples, transferred
 * (not copied). processorOptions: { targetRate, chunkSamples }.
 */
class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions ?? {};
    const targetRate = o.targetRate ?? 16000;
    // 1600 samples @16 kHz = 100ms = 3200 bytes, the chunk size Sarvam documents.
    this.chunk = o.chunkSamples ?? Math.round(targetRate / 10);
    this.ratio = sampleRate / targetRate;
    this.pos = 0; // fractional read head inside `tail`
    this.tail = new Float32Array(0); // input samples not yet consumed
    this.out = new Int16Array(this.chunk);
    this.n = 0;
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e.data === "flush") this.flush();
      else if (e.data === "stop") this.stopped = true;
    };
  }

  flush() {
    if (!this.n) return;
    const copy = this.out.slice(0, this.n);
    this.n = 0;
    this.port.postMessage(copy.buffer, [copy.buffer]);
  }

  process(inputs) {
    if (this.stopped) return false;
    const ch = inputs[0]?.[0];
    // No input connected yet (or a muted track): keep the node alive.
    if (!ch || ch.length === 0) return true;

    const buf = new Float32Array(this.tail.length + ch.length);
    buf.set(this.tail, 0);
    buf.set(ch, this.tail.length);

    let p = this.pos;
    // `p + 1 < length` so the interpolation always has its right-hand neighbour.
    while (p + 1 < buf.length) {
      const i = p | 0;
      const f = p - i;
      let s = buf[i] * (1 - f) + buf[i + 1] * f;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.chunk) this.flush();
      p += this.ratio;
    }

    // Keep the one sample the next interpolation still needs.
    const consumed = p | 0;
    this.tail = buf.slice(consumed);
    this.pos = p - consumed;
    return true;
  }
}

registerProcessor("pcm-downsampler", PcmDownsampler);
