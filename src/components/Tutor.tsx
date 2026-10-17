"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { isGrade, isSubject, type Grade, type SubjectId } from "@/lib/curriculum";
import {
  askPlaceholder,
  classifyFamiliarity,
  DEFAULT_LANGUAGE,
  familiarityQuestion,
  isDoubtCleared,
  isExplainRequest,
  voicePrompts,
} from "@/lib/languages";
import type { Beat, HistoryMessage, LessonPlan, TutorEvent } from "@/lib/schema";
import { AsyncQueue, uid } from "@/lib/utils";
import { Recorder, browserSttAvailable, recognizeBrowser, transcribeOnServer, type SttMode } from "@/lib/voice/stt";
import { LiveTranscriber, liveSttUnavailable, prewarmLiveStt, relayUrl } from "@/lib/voice/live-stt";
import { fetchSpeech, playBlob, speakBrowser, type TtsMode } from "@/lib/voice/tts";
import { isPlaybackPaused, pausePlayback, resumePlayback } from "@/lib/voice/playback";
import ClassSubjectPicker from "./ClassSubjectPicker";
import Composer, { joinDictation } from "./Composer";
import { LogoTile, Wordmark } from "./Logo";
import LanguageMenu from "./LanguageMenu";
import Transcript from "./Transcript";
import VoiceCapture from "./VoiceCapture";
import VoiceReview from "./VoiceReview";
import { useVoiceLoop } from "./useVoiceLoop";
import type { Board } from "./Whiteboard";

// Excalidraw is browser-only; never render it on the server.
const Whiteboard = dynamic(() => import("./Whiteboard"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full w-full place-items-center text-sm text-neutral-500">Loading board…</div>
  ),
});

// The 3D avatar (three.js) is browser-only too — load it on demand, only for voice mode.
const Avatar = dynamic(() => import("./Avatar"), {
  ssr: false,
  loading: () => <div className="grid h-full w-full place-items-center text-[11px] text-white/70">Loading Indica…</div>,
});

export type Status = "idle" | "listening" | "transcribing" | "thinking" | "teaching";
// `hidden` messages are sent to the model but never rendered in the transcript —
// used for the voice loop's silent "keep teaching" nudge after a statement turn.
export type ChatMessage = HistoryMessage & { id: string; pending?: boolean; hidden?: boolean };

/**
 * The staged lesson state machine (see lib/schema.ts `TutorMode`):
 *   none            — no lesson yet; the next topic starts one
 *   awaitFamiliarity— asked the familiarity question, waiting for the answer
 *   teaching        — teaching the plan step by step (Ultra)
 *   doubt           — answering a student's doubt on the side canvas (Groq), paused
 */
export type LessonPhase = "none" | "awaitFamiliarity" | "teaching" | "doubt";

// A statement turn ends "ready to continue"; a question turn ends on "?". We use
// the last character of the spoken reply to tell the two apart.
const isQuestionEnding = (t: string) => /[?？]\s*$/.test(t.trim());
// Hidden user turn that asks the model to teach the next small step. Phrased as
// plain language so the model (which mirrors the student's language) just carries on.
const CONTINUE_NUDGE = "Continue to the next step.";
export type Config = {
  llm: string | null;
  stt: SttMode;
  tts: TtsMode;
  /** Which backend can stream words while the student is still speaking. */
  liveStt: "sarvam" | "browser" | null;
  sttRelayUrl: string | null;
  sttRelayPort: number;
};
const FALLBACK_CONFIG: Config = {
  llm: null,
  stt: "browser",
  tts: "browser",
  liveStt: "browser",
  sttRelayUrl: null,
  sttRelayPort: 8787,
};
type QueuedBeat = { beat: Beat; audio: Promise<Blob | null> | null };

const STATUS_LABEL: Record<Status, string> = {
  idle: "Ready",
  listening: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Indica is thinking…",
  teaching: "Indica is teaching…",
};

function readLocal(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function HamburgerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6.5" y="5" width="4" height="14" rx="1.2" />
      <rect x="13.5" y="5" width="4" height="14" rx="1.2" />
    </svg>
  );
}

// ---- subtitle helpers ------------------------------------------------------

/** Breaks a sentence into subtitle-sized word groups (≈42 chars per line). */
function chunkCaption(text: string): string[][] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[][] = [];
  let line: string[] = [];
  let len = 0;
  for (const w of words) {
    if (line.length && len + 1 + w.length > 42) {
      chunks.push(line);
      line = [];
      len = 0;
    }
    line.push(w);
    len += (len ? 1 : 0) + w.length;
  }
  if (line.length) chunks.push(line);
  return chunks;
}

/**
 * One subtitle line of the sentence being spoken: shows only the chunk that
 * contains the current word, with that word highlighted — spoken words in ink,
 * upcoming words muted, like karaoke. Height never changes. When the chunk is
 * wider than the strip (phones, wide scripts), the active word is scrolled to
 * the centre so the highlight is always on screen.
 */
function KaraokeLine({ text, word }: { text: string; word: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    const active = activeRef.current;
    if (!wrap) return;
    if (!active) {
      wrap.scrollLeft = 0;
      return;
    }
    // Centre the spoken word; a strip wide enough for the whole chunk has no
    // scroll range, so this is a no-op there.
    wrap.scrollLeft = Math.max(0, active.offsetLeft - (wrap.clientWidth - active.offsetWidth) / 2);
  }, [text, word]);

  const chunks = chunkCaption(text);
  let lineStart = 0;
  let line: string[] | null = null;
  for (const c of chunks) {
    if (word < lineStart + c.length) {
      line = c;
      break;
    }
    lineStart += c.length;
  }
  if (!line) {
    line = chunks[chunks.length - 1] ?? [];
    lineStart -= line.length;
  }
  return (
    <div ref={wrapRef} className="relative overflow-hidden whitespace-nowrap text-center">
      {line.map((w, i) => {
        const idx = lineStart + i;
        return (
          <span
            key={idx}
            ref={idx === word ? activeRef : undefined}
            className={
              idx === word
                ? "font-medium text-amber-700"
                : idx < word
                  ? "text-neutral-500"
                  : "text-neutral-400"
            }
          >
            {i > 0 ? " " : ""}
            {w}
          </span>
        );
      })}
    </div>
  );
}

export default function Tutor() {
  const [board, setBoard] = useState<Board | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [language, setLanguage] = useState<string>(DEFAULT_LANGUAGE);
  const [grade, setGrade] = useState<Grade | null>(null);
  const [subject, setSubject] = useState<SubjectId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interim, setInterim] = useState("");
  // What's sitting in the composer. Owned here (not by Composer) so dictation
  // can stream into it and so sending can clear it from anywhere.
  const [draft, setDraft] = useState("");
  const [voiceMode, setVoiceMode] = useState(false); // avatar-only stage, chat hidden
  // The sentence being spoken right now and how far the voice has got into it.
  // Set at playback start (never earlier), advanced word-by-word, cleared at turn
  // end. `id` ties updates to one beat, so two beats with identical text (a
  // repeated "ठीक है?") can never advance each other's caption.
  const [liveCaption, setLiveCaption] = useState<{ id: number; text: string; word: number } | null>(null);
  const capSeqRef = useRef(0);
  const [chatPanelOpen, setChatPanelOpen] = useState(false); // in voice mode, the hamburger brings chat back
  // The student froze Guru mid-sentence (voice is paused, not stopped) and a
  // resume carries on from the same spot. Listening is paused through the voice
  // loop's own "paused" phase instead, so this is only ever true while speaking.
  const [speechPaused, setSpeechPaused] = useState(false);

  // Latest values for use inside async callbacks (kept in sync in an effect, never during render).
  const boardRef = useRef<Board | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const configRef = useRef<Config | null>(null);
  const languageRef = useRef(language);
  const gradeRef = useRef(grade);
  const subjectRef = useRef(subject);
  const statusRef = useRef<Status>("idle");
  const voiceModeRef = useRef(false);
  const chatPanelOpenRef = useRef(false);
  const speechPausedRef = useRef(false);
  useEffect(() => {
    boardRef.current = board;
    messagesRef.current = messages;
    configRef.current = config;
    languageRef.current = language;
    gradeRef.current = grade;
    subjectRef.current = subject;
    statusRef.current = status;
    voiceModeRef.current = voiceMode;
    chatPanelOpenRef.current = chatPanelOpen;
    speechPausedRef.current = speechPaused;
  }, [board, messages, config, language, grade, subject, status, voiceMode, chatPanelOpen, speechPaused]);

  const turnRef = useRef<AbortController | null>(null);
  const turnCounter = useRef(0);
  // Spoken text accumulated for the in-flight turn, and a record of how the last
  // turn ended — both read by the voice loop to decide listen-vs-keep-teaching.
  const turnTextRef = useRef("");
  const lastTurnRef = useRef<{ aborted: boolean; hadText: boolean; endedWithQuestion: boolean }>({
    aborted: true,
    hadText: false,
    endedWithQuestion: false,
  });
  // Staged lesson state: plan designed by Ultra, which step is next, the student's
  // familiarity, and the current phase. Kept in a ref for async callbacks; mirrored
  // into state only where the UI needs it.
  const lessonRef = useRef<{
    phase: LessonPhase;
    plan: LessonPlan | null;
    step: number; // index of the NEXT plan step to teach
    topic: string;
    familiarity: "new" | "some" | "confident" | null;
  }>({ phase: "none", plan: null, step: 0, topic: "", familiarity: null });
  const [lessonPhase, setLessonPhase] = useState<LessonPhase>("none");
  // True from the first teaching turn until the topic is dropped. Distinct from
  // phase "teaching", which is already set while the plan is being designed —
  // there is nothing on the board to have a doubt about until a step runs.
  const [lessonStarted, setLessonStarted] = useState(false);
  const setLesson = useCallback((p: LessonPhase) => {
    lessonRef.current.phase = p;
    setLessonPhase(p);
  }, []);
  const lastSeen = useRef(new Map<string, number>());
  const recorderRef = useRef<Recorder | null>(null);
  const browserRecRef = useRef<{ stop: () => void } | null>(null);
  // Live streaming transcription for the current chat-mode dictation, and
  // whether that dictation should send itself when it ends (Space) or settle
  // into the composer for editing (mic button).
  const liveRef = useRef<LiveTranscriber | null>(null);
  const autoSendRef = useRef(false);

  /**
   * Open a streaming-STT tap on a recording mic so words show up while they're
   * being said. Best-effort by design: no relay, no Web Audio, a refused socket —
   * any of those just means the transcript arrives at the end as it did before.
   */
  const attachLive = useCallback(async (r: Recorder, onText: (t: string) => void) => {
    const cfg = configRef.current;
    const stream = r.mediaStream;
    if (!cfg || cfg.liveStt !== "sarvam" || !stream || liveSttUnavailable()) return;
    const url = relayUrl(cfg);
    if (!url) return;
    const live = new LiveTranscriber(url, languageRef.current, { onText });
    try {
      await live.start(stream);
    } catch {
      return; // fall back to the batch transcript at the end of the turn
    }
    // The turn ended while we were connecting — don't leave a socket open.
    if (recorderRef.current !== r) {
      live.abort();
      return;
    }
    liveRef.current = live;
  }, []);

  // Load server capabilities, then restore the student's saved settings.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json() as Promise<Config>)
      .catch((): Config => FALLBACK_CONFIG)
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        // Get the resampler worklet compiled now, not while the student talks.
        if (c.liveStt === "sarvam") prewarmLiveStt();
        setLanguage(readLocal("guru.language", DEFAULT_LANGUAGE));
        const savedGrade = Number(readLocal("guru.grade", ""));
        if (isGrade(savedGrade)) setGrade(savedGrade);
        const savedSubject = readLocal("guru.subject", "");
        if (isSubject(savedSubject)) setSubject(savedSubject);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onReady = useCallback((b: Board) => {
    boardRef.current = b;
    setBoard(b);
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __guru?: Board }).__guru = b; // handy in DevTools / smoke tests
    }
  }, []);

  const stopTurn = useCallback(() => {
    turnRef.current?.abort();
    turnRef.current = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    // Interrupting clears any freeze so the next turn isn't born paused.
    resumePlayback();
    setSpeechPaused(false);
    // Settle pending replies; drop ones that never got any text so no empty bubble lingers.
    setMessages((m) => m.flatMap((x) => (x.pending ? (x.text ? [{ ...x, pending: false }] : []) : [x])));
    // An interrupted turn must not auto-continue: the student stopped it to speak.
    lastTurnRef.current = { aborted: true, hadText: false, endedWithQuestion: false };
    setLiveCaption(null);
    setStatus("idle");
  }, []);

  const speakBeat = useCallback(async (beat: Beat, audio: Promise<Blob | null> | null, signal: AbortSignal) => {
    const say = beat.say.trim();
    if (!say) return;
    const lang = beat.lang || languageRef.current;
    const nWords = say.split(/\s+/).length;
    const id = ++capSeqRef.current;
    // Advance the caption only while this exact beat is still the live one
    // (a later beat or stopTurn may have replaced it).
    const advance = (word: number) =>
      setLiveCaption((c) =>
        c && c.id === id ? { id, text: say, word: Math.max(c.word, Math.min(nWords - 1, word)) } : c,
      );
    // Some browser engines report no progress at all (Chrome's Google-hosted
    // voices fire no boundary events), so a steady ~150wpm pacer keeps the
    // highlight moving on that path only. We never run it alongside real audio:
    // the pacer is faster than most speech, and via max() it would otherwise
    // drag the highlight ahead of the voice — the visible lag we're avoiding.
    let est = 0;
    let pacer: ReturnType<typeof setInterval> | null = null;
    const begin = () => setLiveCaption({ id, text: say, word: 0 });
    const startPacer = () => {
      pacer = setInterval(() => {
        if (!isPlaybackPaused()) advance(++est); // freeze the karaoke with the voice
      }, 380);
    };
    try {
      if (audio) {
        const blob = await audio;
        if (signal.aborted) return;
        if (blob) {
          // Caption appears the moment the voice starts, never before. Sarvam has
          // no word timestamps, so pace words by elapsed fraction of the audio —
          // this is the sole driver here, so the highlight tracks the real voice.
          begin();
          await playBlob(blob, signal, (f) => advance(Math.floor(f * nWords)));
        } else {
          begin();
          startPacer();
          // Browser TTS word boundaries: chars before the boundary = words spoken.
          await speakBrowser(say, lang, signal, (charIndex) =>
            advance(say.slice(0, charIndex).split(/\s+/).filter(Boolean).length),
          );
        }
      } else {
        begin();
        startPacer();
        await speakBrowser(say, lang, signal, (charIndex) =>
          advance(say.slice(0, charIndex).split(/\s+/).filter(Boolean).length),
        );
      }
    } finally {
      if (pacer) clearInterval(pacer);
      // Speech is over: push the word index past the end so no word renders as
      // "being spoken" while the beat's drawing animation finishes.
      setLiveCaption((c) => (c && c.id === id ? { id, text: say, word: nWords } : c));
    }
  }, []);

  /** Consumer: plays beats in order, drawing and speaking each one concurrently. */
  const playQueue = useCallback(
    async (queue: AsyncQueue<QueuedBeat>, turn: number, assistantId: string, signal: AbortSignal) => {
      const player = boardRef.current?.player;
      if (!player) return;
      let first = true;
      for await (const { beat, audio } of queue) {
        if (signal.aborted) break;
        if (first) {
          setStatus("teaching");
          first = false;
        }
        setMessages((m) =>
          m.map((x) => (x.id === assistantId ? { ...x, text: x.text ? `${x.text} ${beat.say}` : beat.say } : x)),
        );
        // Mirror the accumulating reply into a ref so the voice loop can inspect
        // how this turn ended without waiting on the messages state to settle.
        turnTextRef.current = turnTextRef.current ? `${turnTextRef.current} ${beat.say}` : beat.say;
        await Promise.all([player.applyBeat(beat.draw ?? [], turn, signal), speakBeat(beat, audio, signal)]);
      }
    },
    [speakBeat],
  );

  /**
   * One model-backed turn. The engine shared by every stage: it builds the board
   * summary, posts to /api/tutor with the stage `mode` (+ plan/step/familiarity),
   * stores any returned plan, and streams beats onto the board. `side` draws the
   * turn on the doubt side canvas; `chain` keeps "thinking" at the end so a
   * follow-up turn (plan → teach) starts without a flicker through idle.
   */
  const runTurn = useCallback(
    async (spec: {
      text: string;
      mode: "plan" | "teach" | "doubt" | "explain" | "ask";
      hidden?: boolean;
      step?: number;
      side?: boolean;
      chain?: boolean;
    }) => {
      const b = boardRef.current;
      if (!b) return;
      stopTurn();
      setError(null);
      setInterim("");
      turnTextRef.current = "";

      const ac = new AbortController();
      turnRef.current = ac;
      const turn = ++turnCounter.current;
      const cfg = configRef.current ?? FALLBACK_CONFIG;
      const lang = languageRef.current;

      // Board context: a text summary of what is on the board and what the
      // student just drew. (No screenshots — text only, by design.)
      const elements = b.api.getSceneElements();
      const studentEls = elements.filter((e) => !b.isTutorElement(e));
      const changed = studentEls.filter((e) => (lastSeen.current.get(e.id) ?? -1) < e.version);
      for (const e of studentEls) lastSeen.current.set(e.id, e.version);
      // A doubt answer goes on the side canvas (to the right, longer-lived pointers);
      // every other turn starts a fresh page below previous turns, unless the student
      // just drew (then stay on their page).
      if (spec.side) b.player.beginSide();
      else b.player.advancePage(changed.length > 0);
      const canvas = b.summarizeScene(elements, new Set(changed.map((e) => e.id)), b.player.pageShift);

      const userMsg: ChatMessage = { id: uid("u"), role: "user", text: spec.text, hidden: spec.hidden };
      const assistantId = uid("a");
      const history = [...messagesRef.current.filter((m) => !m.pending), userMsg];
      setMessages([...history, { id: assistantId, role: "assistant", text: "", pending: true }]);
      setStatus("thinking");

      const queue = new AsyncQueue<QueuedBeat>();
      const playing = playQueue(queue, turn, assistantId, ac.signal);

      try {
        const res = await fetch("/api/tutor", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify({
            messages: history.slice(-12).map((m) => ({ role: m.role, text: m.text })),
            canvas,
            language: lang,
            // Class + subject name the NCERT textbook; the RAG backend uses this
            // pair to restrict retrieval to that book's embeddings.
            grade: gradeRef.current,
            subject: subjectRef.current,
            mode: spec.mode,
            plan: lessonRef.current.plan ?? undefined,
            step: spec.step,
            familiarity: lessonRef.current.familiarity ?? undefined,
          }),
        });
        if (!res.ok || !res.body) {
          let msg = `Request failed (${res.status})`;
          try {
            const j = await res.json();
            if (j?.error) msg = j.error;
          } catch {}
          throw new Error(msg);
        }
        await readNdjson(res.body, ac.signal, (ev) => {
          if (ev.type === "beat") {
            // Prefetch speech the moment a beat arrives so audio is ready when its turn comes.
            const audio =
              cfg.tts === "sarvam"
                ? fetchSpeech(ev.beat.say, ev.beat.lang || lang, ac.signal).catch(() => null)
                : null;
            queue.push({ beat: ev.beat, audio });
          } else if (ev.type === "plan") {
            lessonRef.current.plan = ev.plan;
            lessonRef.current.topic = ev.plan.topic || lessonRef.current.topic;
          } else if (ev.type === "error") {
            setError(ev.message);
          }
        });
      } catch (err) {
        if (!ac.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        queue.close();
      }
      await playing;
      if (turnRef.current === ac) {
        turnRef.current = null;
        // Record how this turn ended so the voice loop can decide whether to
        // listen (a question was asked) or keep teaching (a statement turn).
        const finalText = turnTextRef.current;
        lastTurnRef.current = {
          aborted: false,
          hadText: !!finalText.trim(),
          endedWithQuestion: isQuestionEnding(finalText),
        };
        // Same policy as stopTurn: a reply that produced no text (e.g. the planner,
        // which draws nothing, or a model error) disappears instead of leaving an
        // empty bubble.
        setMessages((m) => m.flatMap((x) => (x.id === assistantId ? (x.text ? [{ ...x, pending: false }] : []) : [x])));
        setLiveCaption(null);
        // `chain` turns keep the UI in "thinking" so the voice loop's resume effect
        // doesn't fire in the gap before the next turn (plan → first teach step).
        setStatus(spec.chain ? "thinking" : "idle");
        if (!spec.chain) {
          resumePlayback();
          setSpeechPaused(false);
        }
      }
    },
    [playQueue, stopTurn],
  );

  /** Play tutor beats we generated locally (no API), e.g. the fixed familiarity question. */
  const playLocalBeats = useCallback(
    async (userText: string, beats: Beat[]) => {
      const b = boardRef.current;
      if (!b) return;
      stopTurn();
      setError(null);
      setInterim("");
      turnTextRef.current = "";
      const ac = new AbortController();
      turnRef.current = ac;
      const turn = ++turnCounter.current;
      const cfg = configRef.current ?? FALLBACK_CONFIG;
      b.player.advancePage(false);

      const userMsg: ChatMessage = { id: uid("u"), role: "user", text: userText };
      const assistantId = uid("a");
      const history = [...messagesRef.current.filter((m) => !m.pending), userMsg];
      setMessages([...history, { id: assistantId, role: "assistant", text: "", pending: true }]);
      setStatus("thinking");

      const queue = new AsyncQueue<QueuedBeat>();
      const playing = playQueue(queue, turn, assistantId, ac.signal);
      for (const beat of beats) {
        const audio =
          cfg.tts === "sarvam"
            ? fetchSpeech(beat.say, beat.lang || languageRef.current, ac.signal).catch(() => null)
            : null;
        queue.push({ beat, audio });
      }
      queue.close();
      await playing;
      if (turnRef.current === ac) {
        turnRef.current = null;
        const finalText = turnTextRef.current;
        lastTurnRef.current = {
          aborted: false,
          hadText: !!finalText.trim(),
          endedWithQuestion: isQuestionEnding(finalText),
        };
        setMessages((m) => m.flatMap((x) => (x.id === assistantId ? (x.text ? [{ ...x, pending: false }] : []) : [x])));
        setLiveCaption(null);
        setStatus("idle");
        resumePlayback();
        setSpeechPaused(false);
      }
    },
    [playQueue, stopTurn],
  );

  /** Teach the next un-taught plan step (then advance the pointer). No-op when done. */
  const advanceLesson = useCallback(async () => {
    const L = lessonRef.current;
    if (L.phase !== "teaching" || !L.plan) return;
    if (L.step >= L.plan.steps.length) return; // lesson complete; wait for the student
    const step = L.step;
    setLessonStarted(true); // Indica is about to write on the board
    await runTurn({
      text: step === 0 ? "Begin the lesson." : CONTINUE_NUDGE,
      hidden: true,
      mode: "teach",
      step,
    });
    // Advance only if the step actually finished. If a doubt interrupted it,
    // stopTurn marked the turn aborted — keep the pointer so resuming re-teaches it.
    if (!lastTurnRef.current.aborted) lessonRef.current.step = step + 1;
  }, [runTurn]);

  /**
   * The student said/typed something. Routes it through the lesson state machine:
   *   none            → ask the fixed familiarity question (no API), then wait
   *   awaitFamiliarity→ design the plan (Ultra), then teach step 1
   *   teaching        → treat it as a DOUBT (Groq, side canvas), and pause
   *   doubt           → "got it" resumes the lesson; anything else is another doubt
   */
  const ask = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text || !boardRef.current) return;
      const L = lessonRef.current;

      if (L.phase === "none") {
        L.plan = null;
        L.step = 0;
        L.topic = text;
        L.familiarity = null;
        setLesson("awaitFamiliarity");
        await playLocalBeats(text, [{ say: familiarityQuestion(languageRef.current), lang: languageRef.current, draw: [] }]);
        return;
      }

      if (L.phase === "awaitFamiliarity") {
        L.familiarity = classifyFamiliarity(text);
        L.step = 0;
        setLesson("teaching");
        await runTurn({ text, mode: "plan", chain: true }); // design the lesson (slow, once)
        if (lessonRef.current.plan && lessonRef.current.plan.steps.length > 0) {
          await advanceLesson(); // teach step 1
        } else {
          // Planning failed: fall back so the student isn't stuck on a blank board.
          setLesson("none");
          setLessonStarted(false);
          setStatus("idle");
        }
        return;
      }

      // Asking for a specific textbook item (example / exercise / theorem) is a
      // teaching detour: Ultra works it on the MAIN canvas. The lesson stays paused
      // afterwards (phase "doubt") so "got it" resumes it, like any interruption.
      if (isExplainRequest(text)) {
        setLesson("doubt");
        await runTurn({ text, mode: "explain" }); // main canvas, Ultra
        return;
      }

      if (L.phase === "doubt" && isDoubtCleared(text)) {
        boardRef.current?.player.clearSide();
        setLesson("teaching");
        await advanceLesson(); // resume with the next un-taught step
        return;
      }

      // Otherwise it's a conceptual doubt → Groq on the side canvas, lesson paused.
      setLesson("doubt");
      await runTurn({ text, mode: "doubt", side: true });
    },
    [advanceLesson, playLocalBeats, runTurn, setLesson],
  );

  // Voice-loop hooks: after a statement teaching turn, keep teaching the next step.
  const continueLesson = useCallback(() => {
    void advanceLesson();
  }, [advanceLesson]);
  const shouldContinueLesson = useCallback(() => {
    const L = lessonRef.current;
    // Auto-advance only while teaching and there are steps left; the turn must have
    // produced text and not ended on a question (the last step's practice offer).
    if (L.phase !== "teaching" || !L.plan || L.step >= L.plan.steps.length) return false;
    const t = lastTurnRef.current;
    return !t.aborted && t.hadText && !t.endedWithQuestion;
  }, []);

  // Hands-free conversation loop for voice mode: greets, listens, end-points
  // the student's sentence, submits it, and listens again after each turn.
  const voice = useVoiceLoop({
    enabled: voiceMode,
    status,
    boardReady: !!board && !!config,
    hasConversation: messages.length > 0,
    ask,
    shouldContinue: shouldContinueLesson,
    continueLesson,
    setInterim,
    setError,
    configRef,
    languageRef,
  });
  const voicePhaseRef = useRef(voice.phase);
  useEffect(() => {
    voicePhaseRef.current = voice.phase;
  }, [voice.phase]);

  // ---- microphone (dictation + push-to-talk, normal chat mode) ------------
  //
  // Two ways in, deliberately different endings:
  //   mic button  → dictation. Words stream into the composer as you speak and
  //                 stay there, editable, until you press send (ChatGPT's mic).
  //   hold Space  → push-to-talk. Release sends immediately; that's the point
  //                 of holding a key down, and it's the fast path for a quick
  //                 question mid-lesson.
  // Either way the text appears live, which is the part that was missing: the
  // Sarvam path used to record in silence and only reveal the sentence after
  // the upload finished.

  /** Commit a finished dictation: into the box, or straight out as a question. */
  const finishDictation = useCallback(
    (text: string, autoSend: boolean) => {
      setInterim("");
      const t = text.trim();
      if (!t) {
        setStatus("idle");
        return;
      }
      if (autoSend) void ask(t);
      else {
        setDraft((d) => joinDictation(d, t));
        setStatus("idle");
      }
    },
    [ask],
  );

  const startListening = useCallback(
    async (autoSend = false) => {
      if (statusRef.current === "listening") return;
      stopTurn(); // barge-in: interrupt Guru
      setError(null);
      setInterim("");
      autoSendRef.current = autoSend;
      const cfg = configRef.current;
      const useBrowser = !cfg || cfg.stt === "browser" || typeof MediaRecorder === "undefined";
      setStatus("listening");
      statusRef.current = "listening";
      if (useBrowser) {
        if (!browserSttAvailable()) {
          setStatus("idle");
          setError("This browser has no speech recognition. Use Chrome, or add SARVAM_API_KEY for server-side STT.");
          return;
        }
        // The Web Speech API streams interim hypotheses for free; they go
        // straight into the composer.
        const rec = recognizeBrowser(languageRef.current, setInterim);
        browserRecRef.current = rec;
        rec.result
          .then((text) => {
            browserRecRef.current = null;
            finishDictation(text, autoSendRef.current);
          })
          .catch((e: Error) => {
            browserRecRef.current = null;
            setInterim("");
            setError(e.message);
            setStatus("idle");
          });
        return;
      }
      const r = new Recorder();
      recorderRef.current = r;
      try {
        await r.start();
      } catch {
        recorderRef.current = null;
        setStatus("idle");
        setError("Microphone permission was denied.");
        return;
      }
      // Tap the same mic stream for live partials. The recording continues
      // regardless, so if the relay is down we still get the batch transcript.
      void attachLive(r, setInterim);
    },
    [attachLive, finishDictation, stopTurn],
  );

  const stopListening = useCallback(async () => {
    const autoSend = autoSendRef.current;
    if (browserRecRef.current) {
      browserRecRef.current.stop(); // resolves rec.result → finishDictation
      return;
    }
    const r = recorderRef.current;
    if (!r) return;
    recorderRef.current = null;
    const live = liveRef.current;
    liveRef.current = null;
    // Close the stream and the recording together; the streamed transcript is
    // usually already complete, in which case there's no upload at all.
    const [streamed, blob] = await Promise.all([live ? live.finish() : Promise.resolve(""), r.stop()]);
    if (streamed.trim()) {
      finishDictation(streamed, autoSend);
      return;
    }
    if (blob.size < 1500) {
      setInterim("");
      setStatus("idle");
      return;
    }
    setStatus("transcribing");
    try {
      const text = await transcribeOnServer(blob, languageRef.current);
      if (text.trim()) finishDictation(text, autoSend);
      else {
        setInterim("");
        setStatus("idle");
        setError("Didn't catch that. Try again a little closer to the mic.");
      }
    } catch (e) {
      setInterim("");
      setStatus("idle");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [finishDictation]);

  const toggleMic = useCallback(() => {
    if (statusRef.current === "listening") void stopListening();
    else void startListening(false); // button = dictate into the box
  }, [startListening, stopListening]);

  const {
    pause: voicePause,
    resume: voiceResume,
    listen: voiceListen,
    bargeIn: voiceBargeIn,
    sendReview: voiceSendReview,
  } = voice;

  // The Doubt button (voice stage): interrupt Guru and open the mic for the doubt.
  // The captured utterance flows through ask(), which routes it to the doubt model
  // (or to Ultra, if the student names a textbook example/exercise/theorem).
  const raiseDoubt = useCallback(() => {
    stopTurn();
    voiceBargeIn();
  }, [stopTurn, voiceBargeIn]);

  // The avatar's stop/resume switch — distinct from "awaiting an answer".
  // Speaking → freeze the voice in place (resume carries on from the same word).
  // Listening → stop listening (the loop's own "paused" phase). Paused → undo it.
  // Awaiting an answer or idle → nothing to pause, so this is a no-op (listening
  // begins only on Enter).
  const toggleAvatarPause = useCallback(() => {
    const phase = voicePhaseRef.current;
    const listening = phase === "listening" || phase === "capturing";
    const speaking = statusRef.current === "teaching" || statusRef.current === "thinking" || phase === "greeting";
    if (speechPausedRef.current) {
      resumePlayback();
      setSpeechPaused(false);
    } else if (phase === "paused") {
      voiceResume();
    } else if (listening) {
      voicePause();
    } else if (speaking) {
      // Freeze; if audio hasn't started yet it'll be born frozen.
      pausePlayback();
      setSpeechPaused(true);
    }
  }, [voicePause, voiceResume]);

  // Space = push-to-talk (normal mode) / pause-resume the avatar (voice mode). Esc = interrupt.
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        stopTurn();
        // In voice mode Esc also quietens the loop (skip greeting / stop listening).
        const p = voicePhaseRef.current;
        if (voiceModeRef.current && (p === "greeting" || p === "listening" || p === "capturing")) voicePause();
        return;
      }
      // Enter (voice mode, mic not yet open): Guru is waiting for an answer — start listening.
      if (e.key === "Enter" && !isTyping(e.target)) {
        if (voiceModeRef.current && !chatPanelOpenRef.current) {
          // "awaiting" → open the mic. "review" → send what was heard (the box
          // handles Enter itself while focused; this covers a stray click out).
          if (voicePhaseRef.current === "awaiting") {
            e.preventDefault();
            voiceListen();
          } else if (voicePhaseRef.current === "review") {
            e.preventDefault();
            voiceSendReview();
          }
        }
        return;
      }
      if (e.code === "Space" && !e.repeat && !isTyping(e.target)) {
        e.preventDefault();
        if (voiceModeRef.current) {
          // Same as clicking the avatar: pause/resume Guru. The loop owns the mic,
          // so Space never does push-to-talk here. (Not while the chat face is up.)
          if (!chatPanelOpenRef.current) toggleAvatarPause();
          return;
        }
        void startListening(true); // hold-to-talk: release sends
      }
    };
    const up = (e: KeyboardEvent) => {
      if (voiceModeRef.current) return;
      if (e.code === "Space" && !isTyping(e.target) && statusRef.current === "listening") {
        e.preventDefault();
        void stopListening();
      }
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [startListening, stopListening, stopTurn, voicePause, voiceListen, voiceSendReview, toggleAvatarPause]);

  // Deep link: /?q=your+question asks it automatically once the board and config are ready.
  const autoAsked = useRef(false);
  useEffect(() => {
    if (!board || !config || autoAsked.current) return;
    const q = new URLSearchParams(window.location.search).get("q");
    if (!q) return;
    autoAsked.current = true;
    // Defer out of the effect body: ask() updates state synchronously (stopTurn),
    // which must not run inside the effect's render-phase commit.
    const id = setTimeout(() => void ask(q), 0);
    return () => clearTimeout(id);
  }, [board, config, ask]);

  const newTopic = () => {
    stopTurn();
    boardRef.current?.player.clearAll();
    lastSeen.current.clear();
    setMessages([]);
    setError(null);
    lessonRef.current = { phase: "none", plan: null, step: 0, topic: "", familiarity: null };
    setLessonPhase("none");
    setLessonStarted(false);
  };

  const busy = status === "thinking" || status === "teaching";
  // In voice mode the chat is hidden until the hamburger reopens it.
  const showChat = !voiceMode || chatPanelOpen;
  // The composer invites the right kind of input for the current lesson stage.
  const composerPlaceholder =
    lessonPhase === "awaitFamiliarity"
      ? "Answer: have you learned this before, or is it new?"
      : lessonPhase === "doubt"
        ? "Ask your doubt… (say “got it” to continue the lesson)"
        : askPlaceholder(language);

  // Voice-stage derived state. The student's words get their own box (see
  // showSpeechBox); the caption strip below it carries Indica's side — the
  // greeting/re-prompt, then the sentence being spoken right now.
  const guruListening = voice.phase === "listening" || voice.phase === "capturing";
  const guruSpeaking = status === "teaching" || voice.phase === "greeting";
  // Paused either way: voice frozen mid-sentence, or listening stopped by the loop.
  // This is the stop/resume feature only — it is deliberately NOT set while
  // awaiting an answer, so that state never looks paused.
  const avatarPaused = speechPaused || voice.phase === "paused";
  // Guru asked something and is waiting for the student to press Enter to answer.
  const awaitingAnswer = voice.phase === "awaiting";
  // The student has finished speaking and is checking the transcript before it
  // goes anywhere. Nothing is sent until they press send.
  const reviewing = voice.phase === "review";
  // Is there something a pause would act on right now? (Only then is the avatar a
  // pause control — while awaiting/idle there's nothing to stop.)
  const pausable = guruSpeaking || guruListening || status === "thinking";
  // The words are being worked out — its own phase, so the box can say so
  // without guessing from a status plus a non-empty interim.
  const transcribing = voice.phase === "transcribing";
  // The student's words own the lower third from the mic opening until the text
  // is sent: waveform while they talk → "Transcribing…" → the transcript, ready
  // to edit and send.
  const showSpeechBox = reviewing || guruListening || transcribing;
  // The only states worth a pill in the caption strip; everything else either
  // shows a caption (speaking) or the avatar's own affordance (paused → play).
  // Listening and transcribing are not here: the speech box itself is showing
  // them, and saying it twice in the same corner just reads as a duplicate.
  const stripStatus = status === "thinking" ? "Thinking…" : null;
  // The Doubt button is offered while Guru is working (speaking/teaching/thinking)
  // and not already listening — those are the moments a student wants to break in.
  // Gated on the lesson actually being underway: before that there is no lesson
  // to interrupt, and "doubt" has nothing to attach itself to.
  const canRaiseDoubt =
    lessonStarted &&
    !guruListening &&
    !transcribing &&
    !avatarPaused &&
    (guruSpeaking || status === "thinking" || voice.phase === "processing");

  return (
    <main className="flex h-dvh w-full flex-col-reverse bg-neutral-100 md:flex-row">
      {/* Sidebar (chat). Always shown in normal mode; in voice mode only when reopened. */}
      {showChat && (
      <aside className="flex h-[42dvh] w-full shrink-0 flex-col border-t border-amber-100/80 bg-linear-to-b from-[#fffdf8] via-[#fdfaf2] to-[#fbf5ea] md:h-full md:w-[384px] md:border-r md:border-t-0">
        <header className="flex items-center gap-2.5 border-b border-amber-100/70 bg-linear-to-b from-white/85 to-white/45 px-3.5 py-3 backdrop-blur-md">
          <div className="h-9 w-9 shrink-0 overflow-hidden rounded-xl shadow-sm shadow-orange-500/25 ring-1 ring-black/5">
            <LogoTile className="h-full w-full" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[1.15rem] leading-none">
              <Wordmark />
            </h1>
          </div>
          <LanguageMenu
            value={language}
            onChange={(code) => {
              setLanguage(code);
              writeLocal("guru.language", code);
            }}
          />
        </header>

        <div className="flex items-center gap-2 border-b border-amber-100/60 px-3.5 py-2">
          <ClassSubjectPicker
            grade={grade}
            subject={subject}
            onChange={(next) => {
              setGrade(next.grade);
              setSubject(next.subject);
              writeLocal("guru.grade", next.grade == null ? "" : String(next.grade));
              writeLocal("guru.subject", next.subject ?? "");
            }}
          />
          <button
            type="button"
            onClick={newTopic}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-600 shadow-sm transition hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900 active:scale-95"
          >
            <PlusIcon /> New topic
          </button>
        </div>

        {error && (
          <div className="mx-3 mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 shadow-sm">
            {error}
          </div>
        )}
        {config && !config.llm && (
          <div className="mx-3 mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 shadow-sm">
            No LLM key found. Copy <code>.env.example</code> to <code>.env.local</code>, add
            <code> GOOGLE_GENERATIVE_AI_API_KEY</code> and restart.
          </div>
        )}

        <Transcript messages={messages} status={status} />
        <Composer
          status={status}
          draft={draft}
          onDraftChange={setDraft}
          interim={interim}
          disabled={!board || !config}
          voiceMode={voiceMode}
          placeholder={composerPlaceholder}
          onSend={(t) => {
            setDraft("");
            void ask(t);
          }}
          // In voice mode the hands-free loop owns the mic; the button pauses/resumes it.
          onToggleMic={voiceMode ? (guruListening ? voice.pause : voice.resume) : toggleMic}
          onStop={stopTurn}
          onEnterVoice={() => {
            setVoiceMode(true);
            setChatPanelOpen(false);
          }}
        />
      </aside>
      )}

      {/* Board. min-w-0 lets the flex column shrink when the chat panel opens,
          so right-anchored overlays never get pushed off-screen. In voice mode
          (md+) the board stops before Guru's rail so writing never hides behind him. */}
      <section className="relative min-h-0 min-w-0 flex-1">
        {/* Premium teaching surface painted behind the (transparent) canvas. */}
        <div aria-hidden className="board-surface pointer-events-none absolute inset-0" />
        {/* On the voice stage the canvas viewport stops above the caption strip,
            so Excalidraw's own framing (recenter / fit) can never place drawing
            under the subtitles. The decorative surface still fills the gap. */}
        <div className={"absolute inset-0" + (voiceMode && !chatPanelOpen ? " bottom-10" : "")}>
          <Whiteboard onReady={onReady} />
        </div>
        {busy && !voiceMode && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-neutral-900/85 px-3 py-1 text-xs font-medium text-white shadow">
            {STATUS_LABEL[status]} <span className="opacity-60">· Esc to interrupt</span>
          </div>
        )}
        {voiceMode && (
          <>
            {/* Hamburger — the single voice-mode control. It toggles between the
                stage (full board + presenter) and the chat face (chat panel +
                board, presenter hidden, hands-free loop quietened). */}
            <button
              type="button"
              onClick={() => {
                if (!chatPanelOpen) {
                  voice.pause();
                  setChatPanelOpen(true);
                } else {
                  setChatPanelOpen(false);
                  if (voicePhaseRef.current === "paused") voice.resume();
                }
              }}
              title={chatPanelOpen ? "Back to voice" : "Show chat"}
              aria-label={chatPanelOpen ? "Back to voice" : "Show chat"}
              className="absolute left-3 top-3 z-20 grid h-10 w-10 place-items-center rounded-full bg-white/90 text-neutral-700 shadow ring-1 ring-black/5 backdrop-blur transition hover:bg-white"
            >
              <HamburgerIcon />
            </button>

            {!chatPanelOpen && (
              <>
                {/* Doubt button (bottom-left, mirroring the presenter PiP): interrupt
                    Guru and start listening so the student can ask a doubt hands-free.
                    Word only — a "?" next to it said the same thing twice. */}
                {canRaiseDoubt && (
                  <div className="absolute bottom-5 left-4 z-20 md:bottom-6 md:left-6">
                    {/* A halo that keeps breathing while the button is on offer:
                        it appears mid-lesson, so it has to be findable without
                        competing with Guru's writing. */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -inset-1.5 animate-pulse rounded-full bg-orange-500/35 blur-md [animation-duration:2.8s]"
                    />
                    <button
                      type="button"
                      onClick={raiseDoubt}
                      title="Ask a doubt"
                      aria-label="Ask a doubt"
                      className="relative block rounded-full bg-linear-to-b from-[#fb923c] to-[#e03e22] px-5 py-2.5 text-sm font-semibold tracking-wide text-white shadow-lg shadow-orange-900/30 ring-1 ring-inset ring-white/30 transition duration-150 hover:-translate-y-px hover:shadow-xl hover:shadow-orange-900/35 hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 active:translate-y-0 active:scale-95"
                    >
                      Doubt
                    </button>
                  </div>
                )}

                {/* Presenter PiP (bottom-right, like a video call). Mouth is driven
                    by live audio; amber glow while speaking, rose pulse while
                    listening. Clicking it (or Space) pauses/resumes Guru; hovering
                    reveals the pause button in the centre. */}
                <div className="pointer-events-none absolute bottom-5 right-4 z-20 flex flex-col items-end gap-2 md:bottom-6 md:right-6">
                  <div className="relative">
                    {guruListening && !avatarPaused && (
                      <div
                        aria-hidden
                        className="pointer-events-none absolute -inset-1.5 animate-pulse rounded-full border-4 border-rose-400/70"
                      />
                    )}
                    <button
                      type="button"
                      onClick={toggleAvatarPause}
                      aria-label={avatarPaused ? "Resume" : pausable ? "Pause" : "Indica"}
                      title={avatarPaused ? "Resume (Space)" : pausable ? "Pause (Space)" : undefined}
                      aria-pressed={avatarPaused}
                      className={
                        "group pointer-events-auto relative block h-32 w-32 overflow-hidden rounded-full bg-linear-to-b from-amber-50 to-amber-100 ring-2 transition-shadow duration-300 md:h-40 md:w-40 " +
                        (avatarPaused || pausable ? "cursor-pointer " : "cursor-default ") +
                        (avatarPaused
                          ? "ring-white/80 shadow-2xl"
                          : guruSpeaking
                            ? "ring-amber-400 shadow-[0_0_38px_8px_rgba(245,158,11,0.5)]"
                            : guruListening
                              ? "ring-rose-300 shadow-[0_0_30px_6px_rgba(244,63,94,0.4)]"
                              : "ring-white/70 shadow-2xl")
                      }
                    >
                      <Avatar className="h-full w-full" />
                      {/* Stop/resume affordance only: a play button while paused,
                          otherwise the pause button revealed on hover — but only
                          when there's actually something to pause. While awaiting
                          an answer the avatar shows nothing (it isn't paused). */}
                      {(avatarPaused || pausable) && (
                        <span
                          aria-hidden
                          className={
                            "absolute inset-0 grid place-items-center rounded-full text-white transition-opacity duration-150 " +
                            (avatarPaused
                              ? "bg-neutral-900/45 opacity-100"
                              : "bg-neutral-900/35 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100")
                          }
                        >
                          {avatarPaused ? <PlayIcon /> : <PauseIcon />}
                        </span>
                      )}
                    </button>
                  </div>
                </div>

                {/* Lower-third subtitle: one line high always, theme-translucent,
                    appears exactly when the voice starts and highlights the word
                    being spoken (karaoke). Between speeches the same spot shows
                    the state pill — Listening… / Thinking… — nothing else. */}
                {/* The student's own words: one box from the first syllable to
                    send. It fills live while the mic is open, then unlocks with
                    retry + send. It takes the subtitle's place — Indica's own
                    captions can't apply while the student has the floor — and
                    sits clear of the presenter PiP on md+. */}
                {/* Centred on the stage. On phones the presenter sits in the
                    bottom-right corner at the same height, so the box rides
                    above it instead of running underneath. */}
                {showSpeechBox && (
                  <div className="absolute inset-x-4 bottom-40 z-30 flex justify-center md:bottom-4">
                    {reviewing ? (
                      <VoiceReview
                        value={voice.review}
                        onChange={voice.setReview}
                        onSend={voice.sendReview}
                        onRetry={voice.retryReview}
                      />
                    ) : (
                      <VoiceCapture
                        state={transcribing ? "transcribing" : "live"}
                        levelRef={voice.micLevelRef}
                        onCancel={voice.pause}
                        onStop={voice.endUtterance}
                      />
                    )}
                  </div>
                )}

                {!showSpeechBox && (voice.voiceCaption || liveCaption || awaitingAnswer || stripStatus) && (
                  <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex justify-center">
                    <div
                      aria-live="polite"
                      className="w-fit max-w-[90vw] overflow-hidden whitespace-nowrap rounded-full border border-amber-200/30 bg-[#fffdf7]/45 px-3.5 py-1.5 text-center text-sm leading-none shadow-md shadow-amber-900/5 backdrop-blur-sm md:max-w-2xl md:text-[15px]"
                    >
                      {voice.voiceCaption ? (
                        <KaraokeLine text={voice.voiceCaption.text} word={voice.voiceCaption.word} />
                      ) : liveCaption ? (
                        <KaraokeLine text={liveCaption.text} word={liveCaption.word} />
                      ) : awaitingAnswer ? (
                        // A light, unobtrusive hint — the mic stays shut until Enter.
                        <span className="font-normal text-neutral-400">{voicePrompts(language).answerHint}</span>
                      ) : (
                        <span className="font-medium text-amber-800">{stripStatus}</span>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </section>

      {/* Doubt mode: the answer goes on the side canvas, and the whole viewport
          gets a glowing frame so it is obvious at a glance that the lesson is
          paused on a doubt (say "got it" to resume). Decorative + click-through;
          the markup is bare tags because globals.css styles it by element. */}
      {lessonPhase === "doubt" && (
        <div className="doubt-frame" aria-hidden>
          <header>
            <i />
            <b>Doubt Mode</b>
            <i />
          </header>
          <i className="edge-l" />
          <i className="edge-r" />
          <i className="edge-b" />
        </div>
      )}
    </main>
  );
}

/** Reads an NDJSON stream line by line and dispatches parsed events. */
async function readNdjson(body: ReadableStream<Uint8Array>, signal: AbortSignal, onEvent: (ev: TutorEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line: string) => {
    const s = line.trim();
    if (!s) return;
    try {
      onEvent(JSON.parse(s) as TutorEvent);
    } catch {
      console.warn("[tutor] bad NDJSON line", s);
    }
  };
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (!signal.aborted && buf.trim()) handle(buf);
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
