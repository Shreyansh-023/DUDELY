"use client";

/**
 * The hands-free conversation loop behind voice mode.
 *
 * Flow: enter voice mode → (no conversation yet? Guru speaks a greeting) →
 * listen → the student's single utterance is end-pointed automatically (VAD on
 * the Sarvam path, the browser recogniser's own endpointing otherwise) →
 * transcribe → ask() → Guru teaches → when the turn ends, listen again.
 * 5s of silence → Guru re-asks once; still silent → "paused" until tapped.
 *
 * The loop never opens the mic while Guru is speaking (strictly sequential),
 * and it never writes greetings/re-prompts into the chat history.
 *
 * Concurrency model (matches Tutor's turnCounter pattern): every point that
 * takes control bumps `genRef`; every continuation after an await re-checks it
 * and silently bows out if someone else has taken over.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { voicePrompts } from "@/lib/languages";
import { Recorder, browserSttAvailable, recognizeBrowser, transcribeOnServer, type SttMode } from "@/lib/voice/stt";
import { fetchSpeech, playBlob, speakBrowser, type TtsMode } from "@/lib/voice/tts";
import { MicVad } from "@/lib/voice/vad";
import type { Status } from "./Tutor";

export type VoicePhase = "off" | "greeting" | "listening" | "capturing" | "processing" | "paused";

/** After this many unanswered re-prompts Guru goes quiet until tapped. */
const MAX_REPROMPTS = 1;
/** Browser STT: abort if not even an interim result arrives within this window. */
const NO_INTERIM_TIMEOUT_MS = 5000;

type Config = { llm: string | null; stt: SttMode; tts: TtsMode };

type Deps = {
  enabled: boolean; // voiceMode
  status: Status; // Tutor turn status — drives resume-after-turn
  boardReady: boolean;
  hasConversation: boolean; // read once at entry: greet only on a fresh session
  ask: (text: string) => void;
  setInterim: (t: string) => void;
  setError: (e: string | null) => void;
  configRef: RefObject<Config | null>;
  languageRef: RefObject<string>;
};

export function useVoiceLoop(deps: Deps): {
  phase: VoicePhase;
  voiceCaption: string | null;
  resume: () => void;
  pause: () => void;
} {
  const [phase, setPhaseState] = useState<VoicePhase>("off");
  const [voiceCaption, setVoiceCaption] = useState<string | null>(null);

  // Latest props/state for async continuations (same pattern as Tutor's refs).
  const depsRef = useRef(deps);
  const phaseRef = useRef<VoicePhase>("off");
  useEffect(() => {
    depsRef.current = deps;
  });

  const genRef = useRef(0);
  const greetAbortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const vadRef = useRef<MicVad | null>(null);
  const browserRecRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const noInterimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repromptCountRef = useRef(0);
  const prevStatusRef = useRef<Status>("idle");

  const setPhase = useCallback((p: VoicePhase) => {
    phaseRef.current = p;
    setPhaseState(p);
    if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
      (window as unknown as { __guruVoicePhase?: VoicePhase }).__guruVoicePhase = p; // for smoke tests
    }
  }, []);

  const clearNoInterimTimer = useCallback(() => {
    if (noInterimTimerRef.current) clearTimeout(noInterimTimerRef.current);
    noInterimTimerRef.current = null;
  }, []);

  /** Cancel whatever capture is in flight. Safe to call at any time. */
  const cancelCapture = useCallback(() => {
    vadRef.current?.cancel();
    vadRef.current = null;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    browserRecRef.current?.abort();
    browserRecRef.current = null;
    clearNoInterimTimer();
    depsRef.current.setInterim("");
  }, [clearNoInterimTimer]);

  /** Guru says a prompt out loud (greeting / re-prompt), lip-synced, never logged to chat. */
  const speakPrompt = useCallback(
    async (text: string, gen: number) => {
      if (gen !== genRef.current) return;
      setPhase("greeting");
      setVoiceCaption(text);
      const ac = new AbortController();
      greetAbortRef.current = ac;
      const lang = depsRef.current.languageRef.current;
      try {
        let blob: Blob | null = null;
        if (depsRef.current.configRef.current?.tts === "sarvam") {
          blob = await fetchSpeech(text, lang, ac.signal).catch(() => null); // 204 / failure → browser voice
        }
        if (gen !== genRef.current || ac.signal.aborted) return;
        if (blob) await playBlob(blob, ac.signal);
        else await speakBrowser(text, lang, ac.signal); // self-caps its wait, so this can't wedge the loop
      } finally {
        greetAbortRef.current = null;
        setVoiceCaption(null);
      }
    },
    [setPhase],
  );

  const submit = useCallback(
    (text: string, gen: number) => {
      if (gen !== genRef.current) return;
      repromptCountRef.current = 0;
      setPhase("processing"); // the resume effect listens again once the turn ends
      depsRef.current.ask(text);
    },
    [setPhase],
  );

  const handleNoSpeech = useCallback(
    async (gen: number) => {
      if (gen !== genRef.current) return;
      repromptCountRef.current += 1;
      if (repromptCountRef.current > MAX_REPROMPTS) {
        setPhase("paused");
        return;
      }
      await speakPrompt(voicePrompts(depsRef.current.languageRef.current).reprompt, gen);
      if (gen === genRef.current) void listenOnceRef.current(gen);
    },
    [setPhase, speakPrompt],
  );

  const listenOnce = useCallback(
    async (gen: number) => {
      if (gen !== genRef.current) return;
      const d = depsRef.current;
      if (d.status !== "idle") {
        // A turn is still playing (e.g. voice mode entered mid-lesson); the
        // resume effect will call us again when it finishes.
        setPhase("processing");
        return;
      }
      setPhase("listening");
      d.setInterim("");
      const cfg = d.configRef.current;
      const useBrowser = !cfg || cfg.stt === "browser" || typeof MediaRecorder === "undefined";

      if (useBrowser) {
        if (!browserSttAvailable()) {
          d.setError("This browser has no speech recognition. Use Chrome, or add SARVAM_API_KEY for server-side STT.");
          setPhase("paused");
          return;
        }
        const rec = recognizeBrowser(
          d.languageRef.current,
          (t) => {
            if (!t || gen !== genRef.current) return;
            clearNoInterimTimer();
            if (phaseRef.current === "listening") setPhase("capturing");
            depsRef.current.setInterim(t);
          },
          { singleUtterance: true },
        );
        browserRecRef.current = rec;
        noInterimTimerRef.current = setTimeout(() => rec.abort(), NO_INTERIM_TIMEOUT_MS);
        const text = await rec.result.catch(() => "");
        browserRecRef.current = null;
        clearNoInterimTimer();
        depsRef.current.setInterim("");
        if (gen !== genRef.current) return;
        if (text.trim()) submit(text, gen);
        else void handleNoSpeech(gen);
        return;
      }

      // Sarvam path: record + VAD end-pointing.
      const r = new Recorder();
      recorderRef.current = r;
      try {
        await r.start();
      } catch {
        recorderRef.current = null;
        if (gen !== genRef.current) return;
        d.setError("Microphone permission was denied.");
        setPhase("paused");
        return;
      }
      if (gen !== genRef.current || !r.mediaStream) {
        r.cancel();
        if (recorderRef.current === r) recorderRef.current = null;
        return;
      }
      const vad = new MicVad(r.mediaStream, undefined, {
        onSpeechStart: () => {
          if (gen === genRef.current) setPhase("capturing");
        },
      });
      vadRef.current = vad;
      const outcome = await vad.wait();
      if (vadRef.current === vad) vadRef.current = null;
      if (gen !== genRef.current) {
        r.cancel();
        if (recorderRef.current === r) recorderRef.current = null;
        return;
      }
      if (outcome === "no-speech" || outcome === "cancelled") {
        r.cancel(); // nothing worth transcribing — release the mic without an STT call
        recorderRef.current = null;
        if (outcome === "no-speech") void handleNoSpeech(gen);
        return;
      }
      // "speech-ended" | "max-duration": the sentence is in the can.
      setPhase("processing");
      const blob = await r.stop();
      recorderRef.current = null;
      if (gen !== genRef.current) return;
      if (blob.size < 1500) {
        void handleNoSpeech(gen);
        return;
      }
      try {
        const text = await transcribeOnServer(blob, depsRef.current.languageRef.current);
        if (gen !== genRef.current) return;
        if (text.trim()) submit(text, gen);
        else void handleNoSpeech(gen);
      } catch (e) {
        if (gen !== genRef.current) return;
        depsRef.current.setError(e instanceof Error ? e.message : String(e));
        void handleNoSpeech(gen);
      }
    },
    [clearNoInterimTimer, handleNoSpeech, setPhase, submit],
  );
  // handleNoSpeech → listenOnce → handleNoSpeech is mutually recursive; break the cycle with a ref.
  const listenOnceRef = useRef(listenOnce);
  useEffect(() => {
    listenOnceRef.current = listenOnce;
  }, [listenOnce]);

  /** Full stop: invalidate continuations, kill audio + mic, reset UI. Idempotent. */
  const teardown = useCallback(() => {
    genRef.current += 1;
    greetAbortRef.current?.abort();
    greetAbortRef.current = null;
    cancelCapture();
    repromptCountRef.current = 0;
    setVoiceCaption(null);
    setPhase("off");
  }, [cancelCapture, setPhase]);

  // Enter / exit the loop.
  useEffect(() => {
    if (!deps.enabled || !deps.boardReady) return;
    const gen = ++genRef.current;
    const greetFirst = !depsRef.current.hasConversation;
    if (greetFirst) {
      void speakPrompt(voicePrompts(depsRef.current.languageRef.current).greeting, gen).then(() => {
        if (gen === genRef.current) void listenOnceRef.current(gen);
      });
    } else {
      void listenOnceRef.current(gen);
    }
    return teardown;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps.enabled, deps.boardReady]);

  // Keep the loop turning around Tutor's turn lifecycle.
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = deps.status;
    if (!deps.enabled) return;
    if (phase === "processing" && deps.status === "idle" && prev !== "idle") {
      // Guru finished (or was interrupted) — the student's turn again.
      void listenOnceRef.current(++genRef.current);
    } else if (
      (phase === "listening" || phase === "capturing") &&
      (deps.status === "thinking" || deps.status === "teaching")
    ) {
      // The student typed a question in the chat panel while we were listening:
      // drop the capture and fall in line behind that turn.
      genRef.current += 1;
      cancelCapture();
      setPhase("processing");
    }
  }, [deps.status, deps.enabled, phase, cancelCapture, setPhase]);

  const resume = useCallback(() => {
    if (!depsRef.current.enabled) return;
    repromptCountRef.current = 0;
    depsRef.current.setError(null);
    void listenOnceRef.current(++genRef.current);
  }, []);

  const pause = useCallback(() => {
    genRef.current += 1; // orphan any in-flight continuation (greeting chain included)
    greetAbortRef.current?.abort();
    greetAbortRef.current = null;
    cancelCapture();
    setVoiceCaption(null);
    setPhase("paused");
  }, [cancelCapture, setPhase]);

  return { phase, voiceCaption, resume, pause };
}
