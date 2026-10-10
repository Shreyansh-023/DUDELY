"use client";

import { toWebSpeechLang } from "../languages";
import { attachMediaElement, setSyntheticSpeaking } from "./lipsync";

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

/** Plays an audio blob through an <audio> element; resolves when it ends or the signal aborts. */
export function playBlob(blob: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    attachMediaElement(audio); // route through the lip-sync analyser (true amplitude)
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      audio.onended = null;
      audio.onerror = null;
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

/** Browser fallback: free, works offline, voice quality varies by OS. */
export function speakBrowser(text: string, lang: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || typeof window === "undefined" || !("speechSynthesis" in window)) return resolve();
    const synth = window.speechSynthesis;
    if (!voicesLoaded) {
      synth.getVoices();
      voicesLoaded = true;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = toWebSpeechLang(lang);
    const voice = pickVoice(u.lang);
    if (voice) u.voice = voice;
    u.rate = 1.0;
    // Chrome sometimes never fires onend (and headless browsers have no voices), so cap the wait
    // at a generous estimate of the speaking time.
    const words = text.trim().split(/\s+/).length;
    const maxMs = 1500 + words * 550;
    const finish = () => {
      setSyntheticSpeaking(false);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve();
    };
    const onAbort = () => {
      synth.cancel();
      finish();
    };
    const timer = setTimeout(finish, maxMs);
    signal.addEventListener("abort", onAbort, { once: true });
    u.onend = finish;
    u.onerror = finish;
    synth.cancel();
    setSyntheticSpeaking(true); // open the synthetic mouth gate for the avatar
    synth.speak(u);
  });
}
