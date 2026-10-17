"use client";

/**
 * The hands-free conversation loop behind voice mode.
 *
 * Flow: enter voice mode → (no conversation yet? Guru speaks a greeting) →
 * listen → the student's single utterance is end-pointed automatically (VAD on
 * the Sarvam path, the browser recogniser's own endpointing otherwise) →
 * transcribe → review (the student sees what was heard and can fix it) →
 * ask() → Guru teaches → when the turn ends, listen again.
 * 5s of silence → Guru re-asks once; still silent → "paused" until tapped.
 *
 * The review step exists because recognition is never perfect, least of all on
 * code-mixed Hinglish: sending straight through means a misheard word silently
 * becomes the question Guru answers. Nothing reaches the model until the
 * student presses send.
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
import { Recorder, browserSttAvailable, recognizeBrowser, transcribeOnServer } from "@/lib/voice/stt";
import { LiveTranscriber, liveSttUnavailable, relayUrl } from "@/lib/voice/live-stt";
import { fetchSpeech, playBlob, speakBrowser } from "@/lib/voice/tts";
import { isPlaybackPaused } from "@/lib/voice/playback";
import { MicVad } from "@/lib/voice/vad";
import type { Config, Status } from "./Tutor";

// "awaiting" = Guru has asked something and is waiting for the student to press
// Enter before the mic opens (the student answers in their own time).
// "review"   = the student has finished speaking and is looking at what was
//              heard, free to edit it, say it again, or send.
export type VoicePhase =
  | "off"
  | "greeting"
  | "listening"
  | "capturing"
  | "processing"
  | "awaiting"
  | "review"
  | "paused";

/**
 * How many statement turns Guru may teach back-to-back before pausing to listen.
 * The prompt asks a checkpoint question roughly every third turn, so this cap is
 * only a safety net against a model that never stops to check in.
 */
const MAX_AUTO_CONTINUE = 8;
/** Browser STT: abort if not even an interim result arrives within this window. */
const NO_INTERIM_TIMEOUT_MS = 5000;

type Deps = {
  enabled: boolean; // voiceMode
  status: Status; // Tutor turn status — drives resume-after-turn
  boardReady: boolean;
  hasConversation: boolean; // read once at entry: greet only on a fresh session
  ask: (text: string) => void;
  /** True when the last turn ended on a statement and Guru should keep teaching. */
  shouldContinue: () => boolean;
  /** Ask the model to teach the next small step (a hidden, unspoken-by-student turn). */
  continueLesson: () => void;
  setInterim: (t: string) => void;
  setError: (e: string | null) => void;
  configRef: RefObject<Config | null>;
  languageRef: RefObject<string>;
};

export function useVoiceLoop(deps: Deps): {
  phase: VoicePhase;
  /** The greeting/re-prompt being spoken and how far the voice has got (karaoke). */
  voiceCaption: { text: string; word: number } | null;
  /** What was heard, awaiting the student's approval. Only set in "review". */
  review: string;
  /** The student edited the transcript before sending. */
  setReview: (text: string) => void;
  /** Send the reviewed text to Guru. */
  sendReview: () => void;
  /** Throw the transcript away and listen again. */
  retryReview: () => void;
  resume: () => void;
  pause: () => void;
  /** Open the mic now — called when the student presses Enter in the "awaiting" phase. */
  listen: () => void;
  /** Interrupt Guru and start listening immediately — the Doubt button. */
  bargeIn: () => void;
} {
  const [phase, setPhaseState] = useState<VoicePhase>("off");
  const [voiceCaption, setVoiceCaption] = useState<{ text: string; word: number } | null>(null);
  const [review, setReview] = useState("");

  // Latest props/state for async continuations (same pattern as Tutor's refs).
  const depsRef = useRef(deps);
  const phaseRef = useRef<VoicePhase>("off");
  // Read by sendReview, which fires from a keypress while the box is being edited.
  const reviewRef = useRef("");
  useEffect(() => {
    depsRef.current = deps;
    reviewRef.current = review;
  });

  const genRef = useRef(0);
  const greetAbortRef = useRef<AbortController | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const vadRef = useRef<MicVad | null>(null);
  const liveRef = useRef<LiveTranscriber | null>(null);
  const browserRecRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const noInterimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoContinueRef = useRef(0);
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
    liveRef.current?.abort();
    liveRef.current = null;
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
      const ac = new AbortController();
      greetAbortRef.current = ac;
      const lang = depsRef.current.languageRef.current;
      // Same karaoke pacing as lesson beats: real boundary/progress events when
      // the engine gives them, a ~150wpm pacer when it doesn't.
      const nWords = text.split(/\s+/).length;
      const advance = (word: number) =>
        setVoiceCaption((c) =>
          c && c.text === text ? { text, word: Math.max(c.word, Math.min(nWords - 1, word)) } : c,
        );
      let est = 0;
      let pacer: ReturnType<typeof setInterval> | null = null;
      try {
        let blob: Blob | null = null;
        if (depsRef.current.configRef.current?.tts === "sarvam") {
          blob = await fetchSpeech(text, lang, ac.signal).catch(() => null); // 204 / failure → browser voice
        }
        if (gen !== genRef.current || ac.signal.aborted) return;
        // Caption goes up only once the TTS round trip is done and playback is
        // about to start, so the subtitle and the voice arrive together.
        setVoiceCaption({ text, word: 0 });
        if (blob) {
          // Real audio: elapsed fraction is the sole driver, so the highlight
          // tracks the voice instead of being dragged ahead by the pacer.
          await playBlob(blob, ac.signal, (f) => advance(Math.floor(f * nWords)));
        } else {
          pacer = setInterval(() => {
            if (!isPlaybackPaused()) advance(++est); // freeze the karaoke with the voice
          }, 380); // no boundary events on some engines
          await speakBrowser(text, lang, ac.signal, (charIndex) =>
            advance(text.slice(0, charIndex).split(/\s+/).filter(Boolean).length),
          ); // self-caps its wait, so this can't wedge the loop
        }
      } finally {
        if (pacer) clearInterval(pacer);
        greetAbortRef.current = null;
        setVoiceCaption(null);
      }
    },
    [setPhase],
  );

  /**
   * The utterance is transcribed. Hand it to the student to check rather than
   * to the model — Tutor renders it in an editable box with retry/send.
   */
  const submit = useCallback(
    (text: string, gen: number) => {
      if (gen !== genRef.current) return;
      // Swap the live caption for the reviewable text in one commit, so the box
      // on screen never blanks between the two.
      depsRef.current.setInterim("");
      setReview(text);
      setPhase("review");
    },
    [setPhase],
  );

  /** The student approved the transcript (send button, or Enter). */
  const sendReview = useCallback(() => {
    const text = reviewRef.current.trim();
    if (!text) return;
    genRef.current += 1; // nothing from the finished capture may fire after this
    setReview("");
    autoContinueRef.current = 0; // the student spoke; start a fresh teaching run
    setPhase("processing"); // the resume effect decides what comes next once the turn ends
    depsRef.current.ask(text);
  }, [setPhase]);

  // The mic opened on Enter but caught nothing: say "I didn't hear, can you
  // repeat?" and hand the floor back — the student presses Enter to try again.
  const handleNoSpeech = useCallback(
    async (gen: number) => {
      if (gen !== genRef.current) return;
      await speakPrompt(voicePrompts(depsRef.current.languageRef.current).reprompt, gen);
      if (gen === genRef.current) void listenOnceRef.current(gen); // → "awaiting" (needs Enter)
    },
    [speakPrompt],
  );

  const listenOnce = useCallback(
    async (gen: number, immediate = false, force = false) => {
      if (gen !== genRef.current) return;
      const d = depsRef.current;
      if (!force && d.status !== "idle") {
        // A turn is still playing (e.g. voice mode entered mid-lesson); the
        // resume effect will call us again when it finishes. `force` (barge-in)
        // skips this because the caller just stopped the turn on purpose.
        setPhase("processing");
        return;
      }
      if (!immediate) {
        // Guru expects an answer but doesn't grab the mic — it waits for the
        // student to press Enter (handled in Tutor, which calls listen()).
        setPhase("awaiting");
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
        if (gen !== genRef.current) {
          depsRef.current.setInterim("");
          return;
        }
        if (text.trim()) submit(text, gen); // clears the interim itself
        else {
          depsRef.current.setInterim("");
          void handleNoSpeech(gen);
        }
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
      // Stream the same mic audio to the recogniser so the student's words show
      // up on the caption strip while they're still talking, instead of only
      // after the upload. Purely additive: the recording below is unaffected,
      // and if the relay isn't there we never notice.
      const live = await openLive(cfg, d.languageRef.current, r, (t) => {
        if (gen !== genRef.current) return;
        if (phaseRef.current === "listening" && t.trim()) setPhase("capturing");
        depsRef.current.setInterim(t);
      });
      if (gen !== genRef.current) {
        live?.abort();
        vad.cancel();
        r.cancel();
        if (recorderRef.current === r) recorderRef.current = null;
        return;
      }
      if (live) liveRef.current = live;

      const outcome = await vad.wait();
      if (vadRef.current === vad) vadRef.current = null;
      if (liveRef.current === live) liveRef.current = null;
      if (gen !== genRef.current) {
        live?.abort();
        r.cancel();
        if (recorderRef.current === r) recorderRef.current = null;
        return;
      }
      if (outcome === "no-speech" || outcome === "cancelled") {
        live?.abort();
        r.cancel(); // nothing worth transcribing — release the mic without an STT call
        recorderRef.current = null;
        depsRef.current.setInterim("");
        if (outcome === "no-speech") void handleNoSpeech(gen);
        return;
      }
      // "speech-ended" | "max-duration": the sentence is in the can.
      setPhase("processing");
      const [streamed, blob] = await Promise.all([live ? live.finish() : Promise.resolve(""), r.stop()]);
      recorderRef.current = null;
      if (gen !== genRef.current) return;
      // The streamed transcript is the same model on the same audio, already
      // finished — take it and skip the upload entirely.
      if (streamed.trim()) {
        submit(streamed, gen); // clears the interim itself
        return;
      }
      depsRef.current.setInterim("");
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
    autoContinueRef.current = 0;
    setVoiceCaption(null);
    setReview("");
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
      // Guru finished a turn. If it ended on a statement ("ready to continue"),
      // keep teaching the next step instead of waiting for the student. If it
      // ended on a question (or was interrupted), hand the floor back — but don't
      // grab the mic: go to "awaiting" so the student answers after pressing Enter.
      if (autoContinueRef.current < MAX_AUTO_CONTINUE && depsRef.current.shouldContinue()) {
        autoContinueRef.current += 1;
        depsRef.current.continueLesson(); // stays in "processing"; we land back here when it ends
      } else {
        autoContinueRef.current = 0;
        void listenOnceRef.current(++genRef.current); // not immediate → "awaiting"
      }
    } else if (
      (phase === "listening" || phase === "capturing" || phase === "awaiting" || phase === "review") &&
      (deps.status === "thinking" || deps.status === "teaching")
    ) {
      // A turn started (e.g. the student typed in the chat panel) while we were
      // listening, waiting for Enter, or holding a transcript for review: drop
      // it and fall in behind the turn. (sendReview's own ask() lands here too,
      // but it has already moved us to "processing", so this branch is skipped.)
      genRef.current += 1;
      cancelCapture();
      setReview("");
      setPhase("processing");
    }
  }, [deps.status, deps.enabled, phase, cancelCapture, setPhase]);

  // Resume from a user-initiated pause: go straight back to listening.
  const resume = useCallback(() => {
    if (!depsRef.current.enabled) return;
    autoContinueRef.current = 0;
    setReview("");
    depsRef.current.setError(null);
    void listenOnceRef.current(++genRef.current, true);
  }, []);

  /** "Say it again": bin what was heard and reopen the mic straight away. */
  const retryReview = useCallback(() => {
    if (!depsRef.current.enabled) return;
    autoContinueRef.current = 0;
    setReview("");
    depsRef.current.setError(null);
    void listenOnceRef.current(++genRef.current, true);
  }, []);

  // The student pressed Enter in the "awaiting" phase — open the mic now.
  const listen = useCallback(() => {
    if (!depsRef.current.enabled) return;
    autoContinueRef.current = 0;
    setReview("");
    depsRef.current.setError(null);
    void listenOnceRef.current(++genRef.current, true);
  }, []);

  // The student tapped the Doubt button mid-lesson: whoever stopped Guru's turn,
  // open the mic immediately to capture the doubt (force past the "Guru is speaking"
  // gate, since the interruption is intentional).
  const bargeIn = useCallback(() => {
    if (!depsRef.current.enabled) return;
    greetAbortRef.current?.abort();
    greetAbortRef.current = null;
    cancelCapture();
    autoContinueRef.current = 0;
    setReview("");
    depsRef.current.setError(null);
    void listenOnceRef.current(++genRef.current, true, true);
  }, [cancelCapture]);

  const pause = useCallback(() => {
    genRef.current += 1; // orphan any in-flight continuation (greeting chain included)
    greetAbortRef.current?.abort();
    greetAbortRef.current = null;
    cancelCapture();
    autoContinueRef.current = 0;
    setVoiceCaption(null);
    setReview("");
    setPhase("paused");
  }, [cancelCapture, setPhase]);

  return { phase, voiceCaption, review, setReview, sendReview, retryReview, resume, pause, listen, bargeIn };
}

/**
 * Best-effort streaming transcription over a mic that's already recording.
 * Returns null — never throws — when live text isn't on offer: no Sarvam key,
 * the relay process isn't running, or Web Audio is unavailable. The caller then
 * behaves exactly as it did before streaming existed.
 */
async function openLive(
  cfg: Config | null,
  language: string,
  r: Recorder,
  onText: (t: string) => void,
): Promise<LiveTranscriber | null> {
  const stream = r.mediaStream;
  if (!cfg || cfg.liveStt !== "sarvam" || !stream || liveSttUnavailable()) return null;
  const url = relayUrl(cfg);
  if (!url) return null;
  const live = new LiveTranscriber(url, language, { onText });
  try {
    await live.start(stream);
    return live;
  } catch {
    return null;
  }
}
