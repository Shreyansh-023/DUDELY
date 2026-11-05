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
import { trackGreeting, voicePrompts } from "@/lib/languages";
import { Recorder, browserSttAvailable, recognizeBrowser, transcribeOnServer } from "@/lib/voice/stt";
import { LiveTranscriber, liveSttUnavailable, relayUrl } from "@/lib/voice/live-stt";
import { fetchSpeech, playBlob, speakBrowser } from "@/lib/voice/tts";
import { isPlaybackPaused } from "@/lib/voice/playback";
import { MicVad } from "@/lib/voice/vad";
import type { Config, Status } from "./Tutor";

// "awaiting"     = Guru has asked something and is waiting for the student to
//                  press Enter before the mic opens (they answer in their own time).
// "transcribing" = the utterance is closed and the words are being worked out.
//                  Its own phase, not a flavour of "processing": the student is
//                  shown it, so it must not be guessed at from a status + a
//                  non-empty interim.
// "review"       = the student has finished speaking and is looking at what was
//                  heard, free to edit it, say it again, or send.
export type VoicePhase =
  | "off"
  | "greeting"
  | "listening"
  | "capturing"
  | "transcribing"
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
/**
 * How many times a silent checkpoint reopens the mic before it gives up and
 * waits for a keypress instead. A student who is thinking gets another go; a
 * muted or refused mic stops being re-prompted into.
 */
const MAX_CHECKPOINT_RETRIES = 2;
/**
 * How long "Transcribing…" stays up at minimum. The browser recogniser hands
 * back its final text the instant it endpoints, so without a floor the state
 * would flash past in a frame and read as a glitch rather than a step.
 */
const TRANSCRIBING_MIN_MS = 450;

type Deps = {
  enabled: boolean; // voiceMode
  status: Status; // Tutor turn status — drives resume-after-turn
  boardReady: boolean;
  hasConversation: boolean; // read once at entry: greet only on a fresh session
  ask: (text: string) => void;
  /** True when the last turn ended on a statement and Guru should keep teaching. */
  shouldContinue: () => boolean;
  /**
   * True while Guru is waiting on an answer it asked for out loud and the mic
   * should open by itself — the lesson's between-step checkpoints.
   *
   * The loop's usual ending for a question is "awaiting": the floor goes back to
   * the student but the mic stays shut until they press Enter, which is right
   * for a question they may want to think about or type. A checkpoint is the
   * opposite — it is asked after every single step, and making the student reach
   * for a key eight times a lesson to say "no, carry on" is precisely the
   * friction the checkpoint exists to remove. So this one opens the mic.
   */
  autoListen: () => boolean;
  /** Ask the model to teach the next small step (a hidden, unspoken-by-student turn). */
  continueLesson: () => void;
  setInterim: (t: string) => void;
  setError: (e: string | null) => void;
  configRef: RefObject<Config | null>;
  languageRef: RefObject<string>;
  /** Which pipeline the student picked, so the greeting asks for the right
   *  thing: a topic in study mode, a question in a question session. Null only
   *  before a pick, which the greeting never sees — the voice stage opens
   *  because a mode was chosen — so it falls back to the study wording. */
  trackRef: RefObject<"learn" | "solve" | null>;
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
  /** Go to "awaiting" without opening the mic. */
  standBy: () => void;
  pause: () => void;
  /** Open the mic now — called when the student presses Enter in the "awaiting" phase. */
  listen: () => void;
  /**
   * Open the mic for an answer Guru has just finished asking for out loud — the
   * lesson's between-step checkpoints.
   *
   * Separate from `listen` because it forces past the "a turn is still playing"
   * gate. The caller has just spoken the question itself and is holding the
   * lesson still until the answer arrives, so the gate's premise — that
   * something is mid-flight and the mic would be talking over it — is already
   * false; and `deps.status` is a render away from catching up, so leaving the
   * decision to the gate turns the mic on or off by luck.
   */
  listenForAnswer: () => void;
  /** Interrupt Guru and start listening immediately — the Doubt button. */
  bargeIn: () => void;
  /** Close the utterance now and transcribe it — the stop button on the waveform. */
  endUtterance: () => void;
  /**
   * Live mic loudness, 0..~0.3 RMS, for the waveform. A ref, not state: it
   * changes 20x a second and nothing in the tree should re-render for it.
   * Stays 0 on the browser-STT path, which never hands us the stream.
   */
  micLevelRef: RefObject<number>;
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
  /** Consecutive silent tries at the checkpoint currently waiting (see
   *  MAX_CHECKPOINT_RETRIES). Reset whenever something is actually heard. */
  const silentCheckpointsRef = useRef(0);
  const prevStatusRef = useRef<Status>("idle");
  const micLevelRef = useRef(0);
  const transcribeAtRef = useRef(0);

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
    micLevelRef.current = 0;
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
      silentCheckpointsRef.current = 0; // something was heard; the mic works
      const show = () => {
        if (gen !== genRef.current) return;
        // Swap the live caption for the reviewable text in one commit, so the box
        // on screen never blanks between the two.
        depsRef.current.setInterim("");
        micLevelRef.current = 0;
        setReview(text);
        setPhase("review");
      };
      // Let "Transcribing…" be read before the words land on top of it.
      const left = TRANSCRIBING_MIN_MS - (performance.now() - transcribeAtRef.current);
      if (phaseRef.current === "transcribing" && left > 0) setTimeout(show, left);
      else show();
    },
    [setPhase],
  );

  /** The utterance is closed; the words are being worked out. */
  const beginTranscribing = useCallback(() => {
    transcribeAtRef.current = performance.now();
    micLevelRef.current = 0;
    setPhase("transcribing");
  }, [setPhase]);

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
      if (gen !== genRef.current) return;
      // At a checkpoint the mic goes back up after the re-prompt rather than
      // stopping at "awaiting". The lesson is parked on this answer and nothing
      // else can move it along, so landing on a phase that needs a keypress
      // would strand a hands-free student mid-lesson — the one place where
      // "press Enter to speak" is not a safe resting state. Everywhere else it
      // still is: the student asked for nothing and owes no answer.
      //
      // Bounded, because the reason for the silence may be a muted or refused
      // mic, and reopening it forever would re-prompt into a void. After a
      // couple of tries it settles on "awaiting" like any other question, where
      // Enter (or the chat composer) is still a way through.
      const retry = depsRef.current.autoListen() && silentCheckpointsRef.current < MAX_CHECKPOINT_RETRIES;
      if (retry) silentCheckpointsRef.current += 1;
      void listenOnceRef.current(gen, retry, retry);
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
        if (text.trim()) {
          // The browser recogniser returns its final text the moment it
          // endpoints, so there is nothing to wait for — but the student still
          // gets the beat, so the handover reads as a step and not a jump.
          beginTranscribing();
          submit(text, gen); // clears the interim itself
        } else {
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
        // Drives the waveform. Written to a ref on purpose — this fires 20x a
        // second and the board must not re-render for it.
        onLevel: (rms) => {
          if (gen === genRef.current) micLevelRef.current = rms;
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
      beginTranscribing();
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
    [beginTranscribing, clearNoInterimTimer, handleNoSpeech, setPhase, submit],
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
      const greeting = trackGreeting(
        depsRef.current.languageRef.current,
        depsRef.current.trackRef.current ?? "learn",
      );
      void speakPrompt(greeting, gen).then(() => {
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
        // A checkpoint asked its question out loud and is waiting on the answer:
        // open the mic rather than stopping at "awaiting" for an Enter.
        void listenOnceRef.current(++genRef.current, depsRef.current.autoListen());
      }
    } else if (
      (phase === "listening" ||
        phase === "capturing" ||
        phase === "transcribing" ||
        phase === "awaiting" ||
        phase === "review") &&
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

  // A checkpoint has asked its question and the lesson is parked on the answer:
  // open the mic straight away, forcing past the turn gate (see listenForAnswer).
  const listenForAnswer = useCallback(() => {
    if (!depsRef.current.enabled) return;
    autoContinueRef.current = 0;
    silentCheckpointsRef.current = 0; // a new checkpoint gets its own retries
    setReview("");
    depsRef.current.setError(null);
    void listenOnceRef.current(++genRef.current, true, true);
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

  /**
   * "I've finished" — close the utterance now instead of waiting out the
   * trailing silence, and transcribe what was said. A no-op unless the mic is
   * actually open.
   */
  const endUtterance = useCallback(() => {
    const phase = phaseRef.current;
    if (phase !== "listening" && phase !== "capturing") return;
    // Whichever path is live: the browser recogniser finalises on stop(), the
    // VAD resolves its wait() as if the silence had run out.
    browserRecRef.current?.stop();
    vadRef.current?.end();
  }, []);

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

  // Hand the floor back without opening the mic: settle on "awaiting" so the
  // student presses Enter when they're ready (e.g. returning from the keyboard).
  const standBy = useCallback(() => {
    if (!depsRef.current.enabled) return;
    genRef.current += 1;
    cancelCapture();
    autoContinueRef.current = 0;
    setReview("");
    depsRef.current.setError(null);
    setPhase("awaiting");
  }, [cancelCapture, setPhase]);

  return {
    phase,
    voiceCaption,
    review,
    setReview,
    sendReview,
    retryReview,
    resume,
    standBy,
    pause,
    listen,
    listenForAnswer,
    bargeIn,
    endUtterance,
    micLevelRef,
  };
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
