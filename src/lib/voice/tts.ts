"use client";

import { toWebSpeechLang } from "../languages";
import { attachMediaElement, setSyntheticSpeaking } from "./lipsync";
import { isPlaybackPaused, registerPlayback } from "./playback";

export type TtsMode = "sarvam" | "browser";

/**
 * Fetches synthesized speech from the server (Sarvam Bulbul). Returns null
 * when the server has no TTS configured so the caller falls back to the
 * browser's speechSynthesis.
 */
export async function fetchSpeech(text: string, lang: string, signal?: AbortSignal): Promise<Blob | null> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, lang }),
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
 * reaches it — exact word-level timing for karaoke captions.
 */
export function speakBrowser(
  text: string,
  lang: string,
  signal: AbortSignal,
  onBoundary?: (charIndex: number) => void,
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
    u.rate = 1.0;
    // Chrome sometimes never fires onend (and headless browsers have no voices), so cap the wait
    // at a generous estimate of the speaking time.
    const words = text.trim().split(/\s+/).length;
    const maxMs = 1500 + words * 550;
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
