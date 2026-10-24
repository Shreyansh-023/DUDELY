"use client";

import { toWebSpeechLang } from "../languages";
import { attachMediaElement, setSyntheticSpeaking } from "./lipsync";
import { isPlaybackPaused, registerPlayback } from "./playback";

export type TtsMode = "sarvam" | "browser";

/**
 * Fetches synthesized speech from the server (Sarvam Bulbul). Returns null
 * when the server has no TTS configured so the caller falls back to the
 * browser's speechSynthesis. `pace` overrides the server's session default
 * (TTS_PACE) for this one line.
 */
export async function fetchSpeech(
  text: string,
  lang: string,
  signal?: AbortSignal,
  pace?: number,
): Promise<Blob | null> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, lang, ...(pace ? { pace } : {}) }),
    signal,
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`TTS failed: ${res.status} ${await res.text()}`);
  return await res.blob();
}

/**
 * Plays an audio blob through an <audio> element; resolves when it ends or the
 * signal aborts. `onProgress` (0..1 of playback position) lets the caller pace
 * captions to the voice — Sarvam gives no word timestamps, so callers estimate
 * the spoken word from elapsed fraction.
 */
export function playBlob(blob: Blob, signal: AbortSignal, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    attachMediaElement(audio); // route through the lip-sync analyser (true amplitude)
    if (onProgress) {
      audio.ontimeupdate = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) onProgress(audio.currentTime / audio.duration);
      };
    }
    // A pause freezes playback where it is (the <audio> element keeps its
    // position); a resume plays on, unless the turn was aborted meanwhile.
    const unregister = registerPlayback({
      pause: () => audio.pause(),
      resume: () => {
        if (!signal.aborted) void audio.play().catch(() => {});
      },
    });
    const finish = () => {
      unregister();
      signal.removeEventListener("abort", onAbort);
      audio.onended = null;
      audio.onerror = null;
      audio.ontimeupdate = null;
      URL.revokeObjectURL(url);
      resolve();
    };
    const onAbort = () => {
      audio.pause();
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    audio.onended = finish;
    audio.onerror = finish;
    audio.play().catch(() => finish());
  });
}

/**
 * Speech for one of the app's own fixed lines — the familiarity question, the
 * lines Indica says while the planner thinks. They are identical every lesson,
 * so they are synthesized once per language and then start instantly, which
 * matters most for the filler: it is what covers the planner's thinking time and
 * so has to begin the moment the student stops talking.
 *
 * Deliberately not tied to a turn's AbortSignal: a cached entry outlives the
 * turn that created it, and an aborted fetch would poison it for the rest of the
 * session. These are single sentences, so letting one finish costs nothing.
 */
const fixedSpeech = new Map<string, Promise<Blob | null>>();

export function fetchFixedSpeech(text: string, lang: string, pace?: number): Promise<Blob | null> {
  const key = `${lang}|${pace ?? ""}|${text}`;
  const hit = fixedSpeech.get(key);
  if (hit) return hit;
  const pending = fetchSpeech(text, lang, undefined, pace).catch(() => null);
  // There are only a handful of fixed lines per language, but don't let a
  // language-hopping session grow this without bound.
  if (fixedSpeech.size > 32) fixedSpeech.clear();
  fixedSpeech.set(key, pending);
  return pending;
}

let voicesLoaded = false;
function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const exact = voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase());
  if (exact) return exact;
  const prefix = lang.split("-")[0].toLowerCase();
  return voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
}

/**
 * Browser fallback: free, works offline, voice quality varies by OS.
 * `onBoundary` fires with the character index of each word as the engine
 * reaches it — exact word-level timing for karaoke captions. `rate` is the
 * speechSynthesis counterpart of Sarvam's `pace`, so both voices speak at the
 * one pace the session was configured with.
 */
export function speakBrowser(
  text: string,
  lang: string,
  signal: AbortSignal,
  onBoundary?: (charIndex: number) => void,
  rate = 1.0,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || typeof window === "undefined" || !("speechSynthesis" in window)) return resolve();
    const synth = window.speechSynthesis;
    if (!voicesLoaded) {
      synth.getVoices();
      voicesLoaded = true;
    }
    const u = new SpeechSynthesisUtterance(text);
    if (onBoundary) {
      // Engines disagree on `name` ("word", "", undefined) — accept everything
      // except explicit sentence boundaries.
      u.onboundary = (e) => {
        if (e.name !== "sentence") onBoundary(e.charIndex);
      };
    }
    u.lang = toWebSpeechLang(lang);
    const voice = pickVoice(u.lang);
    if (voice) u.voice = voice;
    u.rate = Math.min(2, Math.max(0.5, rate));
    // Chrome sometimes never fires onend (and headless browsers have no voices), so cap the wait
    // at a generous estimate of the speaking time — which stretches as the rate drops,
    // or the cap would cut a deliberately slow voice off mid-sentence.
    const words = text.trim().split(/\s+/).length;
    const maxMs = (1500 + words * 550) / u.rate;
    // The cap can't count time spent frozen, so track what's left and restart it
    // across a pause/resume.
    let timer: ReturnType<typeof setTimeout>;
    let timerStart = Date.now();
    let remaining = maxMs;
    let started = false;
    const cut = () => {
      synth.cancel();
      finish();
    };
    const finish = () => {
      unregister();
      setSyntheticSpeaking(false);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      // Detach so a beat that resolved early can't keep firing events (or
      // closing the mouth gate) into the next beat's playback.
      u.onboundary = null;
      u.onend = null;
      u.onerror = null;
      resolve();
    };
    const onAbort = () => {
      synth.cancel();
      finish();
    };
    // Begin (or re-begin, if a pause landed before the voice ever started)
    // speaking: open the mouth gate and start the safety cap.
    const beginSpeaking = () => {
      started = true;
      timerStart = Date.now();
      timer = setTimeout(cut, Math.max(0, remaining));
      setSyntheticSpeaking(true); // open the synthetic mouth gate for the avatar
      synth.cancel();
      synth.speak(u);
    };
    // Freezing: hold the engine (buggy on some browsers, but harmless), close
    // the mouth gate, and stop the clock so the cap doesn't cut a paused voice.
    const unregister = registerPlayback({
      pause: () => {
        clearTimeout(timer);
        if (started) remaining -= Date.now() - timerStart;
        setSyntheticSpeaking(false);
        try {
          synth.pause();
        } catch {}
      },
      resume: () => {
        if (signal.aborted) return;
        if (!started) return beginSpeaking(); // pause landed before the first word
        timerStart = Date.now();
        timer = setTimeout(cut, Math.max(0, remaining));
        setSyntheticSpeaking(true);
        try {
          synth.resume();
        } catch {}
      },
    });
    signal.addEventListener("abort", onAbort, { once: true });
    u.onend = finish;
    u.onerror = finish;
    // Don't start into a paused world — registerPlayback froze us; resume begins it.
    if (!isPlaybackPaused()) beginSpeaking();
  });
}
