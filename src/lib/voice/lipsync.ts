"use client";

/**
 * Shared Web Audio graph that produces a single "mouth level" (0..1) the avatar
 * reads every animation frame. The mouth only moves when sound is actually
 * being produced — there are two sources:
 *
 *  1. Sarvam TTS: the real <audio> element is routed through an AnalyserNode, so
 *     the mouth tracks the true amplitude of the playing voice.
 *  2. Browser speechSynthesis: there is no analysable audio stream, so we
 *     synthesise a gentle flap that is gated on a "speaking" flag the TTS layer
 *     toggles around each utterance. The mouth still only moves while talking.
 *
 * Everything degrades gracefully: if Web Audio is unavailable the level decays
 * to 0 and the avatar simply sits still.
 */

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let timeData: Uint8Array<ArrayBuffer> | null = null;
const attached = new WeakSet<HTMLMediaElement>(); // a MediaElementSource may be created only once per element
let syntheticSpeaking = false; // browser-TTS gate
let smoothed = 0; // last emitted level, for temporal smoothing

const clamp = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    timeData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** The page-wide AudioContext (created/resumed on demand), shared with the mic VAD. */
export function getAudioContext(): AudioContext | null {
  return ensureCtx();
}

/**
 * Routes a playing media element through the analyser so its amplitude drives the
 * mouth. Safe to call once per element; subsequent calls (or failures) are no-ops
 * and the element still plays normally.
 */
export function attachMediaElement(el: HTMLMediaElement): void {
  const c = ensureCtx();
  if (!c || !analyser || attached.has(el)) return;
  try {
    const src = c.createMediaElementSource(el);
    src.connect(analyser);
    analyser.connect(c.destination); // duplicate connects are ignored by the spec
    attached.add(el);
  } catch {
    // Already connected elsewhere, or element not eligible — leave it playing untapped.
  }
}

/** Browser-TTS path: open/close the synthetic mouth gate around an utterance. */
export function setSyntheticSpeaking(on: boolean): void {
  syntheticSpeaking = on;
  if (on) ensureCtx();
}

/**
 * Current mouth-open amount in 0..1, smoothed. Call once per animation frame.
 * Opens quickly and closes a little slower, which reads as natural speech.
 */
export function mouthLevel(): number {
  if (syntheticSpeaking) {
    const t = performance.now() / 1000;
    const base = 0.3 + 0.3 * Math.abs(Math.sin(t * 9.0)) + 0.12 * Math.abs(Math.sin(t * 17.0 + 1.0));
    smoothed += (base - smoothed) * 0.4;
    return clamp(smoothed);
  }
  if (!analyser || !timeData) {
    smoothed *= 0.8;
    return smoothed;
  }
  analyser.getByteTimeDomainData(timeData);
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = (timeData[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / timeData.length); // ~0 silence .. ~0.2 loud speech
  const target = clamp((rms - 0.01) * 6);
  const k = target > smoothed ? 0.5 : 0.18; // snap open, ease closed
  smoothed += (target - smoothed) * k;
  return clamp(smoothed);
}

/** True while Guru is producing sound — used for the "speaking" glow. */
export function isSpeaking(): boolean {
  return syntheticSpeaking || smoothed > 0.06;
}
