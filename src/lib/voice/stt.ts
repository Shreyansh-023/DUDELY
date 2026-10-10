"use client";

import { toWebSpeechLang } from "../languages";

export type SttMode = "sarvam" | "groq" | "browser";

/** Records microphone audio (webm/opus or whatever the browser supports) for server-side STT. */
export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  get mimeType(): string {
    return this.rec?.mimeType || "audio/webm";
  }

  /** The live mic stream while recording (for VAD taps). The Recorder still owns the tracks. */
  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
    const mimeType = preferred.find((m) => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(250);
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec) return resolve(new Blob());
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType });
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.rec = null;
        resolve(blob);
      };
      rec.stop();
    });
  }

  cancel() {
    try {
      this.rec?.stop();
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.rec = null;
  }
}

/** Sends recorded audio to /api/stt and returns the transcript. */
export async function transcribeOnServer(blob: Blob, lang: string): Promise<string> {
  const fd = new FormData();
  const ext = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
  fd.append("file", blob, `speech.${ext}`);
  fd.append("language", lang);
  const res = await fetch("/api/stt", { method: "POST", body: fd });
  if (!res.ok) throw new Error(`STT failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { transcript: string };
  return data.transcript ?? "";
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
}

export function browserSttAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/**
 * Browser Web Speech API recogniser. Free, decent for Hindi/English in Chrome,
 * weaker for other Indic languages and for Hinglish code-mixing.
 */
export function recognizeBrowser(
  lang: string,
  onInterim: (text: string) => void,
  opts: { singleUtterance?: boolean } = {},
): { stop: () => void; abort: () => void; result: Promise<string> } {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) {
    return {
      stop: () => {},
      abort: () => {},
      result: Promise.reject(new Error("Speech recognition not supported in this browser")),
    };
  }
  const rec = new Ctor();
  rec.lang = toWebSpeechLang(lang);
  // Single-utterance mode (hands-free voice loop): the browser endpoints after
  // one phrase and fires onend by itself. Continuous mode is push-to-talk.
  rec.continuous = !opts.singleUtterance;
  rec.interimResults = true;

  let finalText = "";
  const result = new Promise<string>((resolve, reject) => {
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const t = res[0]?.transcript ?? "";
        if (res.isFinal) finalText += t + " ";
        else interim += t;
      }
      onInterim((finalText + interim).trim());
    };
    rec.onerror = (ev) => {
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      reject(new Error(`Speech recognition error: ${ev.error}`));
    };
    rec.onend = () => resolve(finalText.trim());
  });
  rec.start();
  // abort() discards anything heard so far; the "aborted" error is swallowed
  // above, so `result` still settles (as "") via onend.
  return { stop: () => rec.stop(), abort: () => rec.abort(), result };
}
