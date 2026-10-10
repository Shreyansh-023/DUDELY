"use client";

/**
 * Microphone voice-activity detection for the hands-free voice loop.
 *
 * Taps a live MediaStream through an AnalyserNode (never connected to the
 * speakers) and watches the RMS level on a 50ms interval — setInterval rather
 * than rAF so detection keeps running in background tabs. Hysteresis: a higher
 * bar to *enter* speech than to *stay* in it, so trailing consonants don't
 * chop the utterance early.
 *
 * Lifecycle: the caller owns the stream/Recorder; MicVad only ever disconnects
 * its own analyser tap.
 */

import { getAudioContext } from "./lipsync";

export type VadOutcome = "speech-ended" | "no-speech" | "max-duration" | "cancelled";

export interface VadOptions {
  /** RMS (0..~1, speech is typically 0.02–0.2) that counts as voice starting. */
  startThreshold: number;
  /** Lower bar to remain "speaking" once started (hysteresis). */
  stopThreshold: number;
  /** Loudness must be sustained this long before we call it speech (rejects clicks). */
  minSpeechMs: number;
  /** Silence this long after speech = end of the utterance. */
  trailingSilenceMs: number;
  /** Give up waiting for speech to start after this long. */
  noSpeechTimeoutMs: number;
  /** Hard cap on one utterance — the tutor expects a single sentence. */
  maxUtteranceMs: number;
  /** Analysis interval. */
  tickMs: number;
}

export const VAD_DEFAULTS: VadOptions = {
  startThreshold: 0.015,
  stopThreshold: 0.008,
  minSpeechMs: 150,
  trailingSilenceMs: 1200,
  noSpeechTimeoutMs: 5000,
  maxUtteranceMs: 15000,
  tickMs: 50,
};

export class MicVad {
  private opts: VadOptions;
  private events: { onSpeechStart?: () => void; onLevel?: (rms: number) => void };
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private settle: ((outcome: VadOutcome) => void) | null = null;
  private done: Promise<VadOutcome>;

  constructor(
    stream: MediaStream,
    opts?: Partial<VadOptions>,
    events?: { onSpeechStart?: () => void; onLevel?: (rms: number) => void },
  ) {
    this.opts = { ...VAD_DEFAULTS, ...opts };
    this.events = events ?? {};
    this.done = new Promise<VadOutcome>((resolve) => {
      this.settle = resolve;
    });

    const ctx = getAudioContext();
    if (!ctx) {
      // No Web Audio — behave as if the student never spoke so the loop re-prompts.
      setTimeout(() => this.finish("no-speech"), this.opts.noSpeechTimeoutMs);
      return;
    }
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.4;
    this.data = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this.source = ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser); // analyser only — the mic is never monitored to speakers

    const startedAt = performance.now();
    let loudSinceMs = 0; // consecutive loud time while waiting for speech to start
    let speaking = false;
    let lastLoudAt = 0;

    this.timer = setInterval(() => {
      const rms = this.rms();
      this.events.onLevel?.(rms);
      const now = performance.now();
      if (!speaking) {
        loudSinceMs = rms >= this.opts.startThreshold ? loudSinceMs + this.opts.tickMs : 0;
        if (loudSinceMs >= this.opts.minSpeechMs) {
          speaking = true;
          lastLoudAt = now;
          this.events.onSpeechStart?.();
        } else if (now - startedAt >= this.opts.noSpeechTimeoutMs) {
          this.finish("no-speech");
        }
        return;
      }
      if (rms >= this.opts.stopThreshold) lastLoudAt = now;
      if (now - lastLoudAt >= this.opts.trailingSilenceMs) this.finish("speech-ended");
      else if (now - startedAt >= this.opts.maxUtteranceMs) this.finish("max-duration");
    }, this.opts.tickMs);
  }

  /** Resolves exactly once with how listening ended. */
  wait(): Promise<VadOutcome> {
    return this.done;
  }

  /** Stop analysing and resolve wait() with "cancelled". Idempotent. */
  cancel(): void {
    this.finish("cancelled");
  }

  private finish(outcome: VadOutcome): void {
    const settle = this.settle;
    if (!settle) return;
    this.settle = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.source?.disconnect();
    } catch {}
    this.source = null;
    this.analyser = null;
    settle(outcome);
  }

  private rms(): number {
    if (!this.analyser || !this.data) return 0;
    this.analyser.getByteTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.data.length);
  }
}

// Dev-only hook so headless tests can exercise the VAD with a synthetic stream
// (OscillatorNode → MediaStreamAudioDestinationNode) instead of a real mic.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __guruVad?: typeof MicVad }).__guruVad = MicVad;
}
