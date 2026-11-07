"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { isGrade, isSubject, subjectsForGrade, type Grade, type SubjectId } from "@/lib/curriculum";
import {
  askPlaceholder,
  checkpointHandover,
  checkpointQuestion,
  classifyFamiliarity,
  DEFAULT_LANGUAGE,
  familiarityQuestion,
  isAnswerDodge,
  isCheckpointClear,
  isDoubtCleared,
  isExplainRequest,
  isNextQuestion,
  planningHolds,
  planningLines,
  planningStepLead,
  stripStepNumber,
  resumeLine,
  roadmapIntro,
  voicePrompts,
} from "@/lib/languages";
import {
  CONTENT_BOTTOM,
  CONTENT_LEFT,
  CONTENT_RIGHT,
  CONTENT_TOP,
  FIT_MARGIN,
  headedPageCanvas,
  STEP_RULE_OFFSET,
} from "@/lib/canvas/page";
import { downloadBoardPdf, pdfPageList } from "@/lib/canvas/pdf";
import type {
  AnswerGrade,
  Beat,
  CheckpointPlan,
  DrawOp,
  HistoryMessage,
  LessonPlan,
  LessonRecord,
  TutorEvent,
  TutorTrack,
} from "@/lib/schema";
import { AsyncQueue, uid } from "@/lib/utils";
import { Recorder, browserSttAvailable, recognizeBrowser, transcribeOnServer, type SttMode } from "@/lib/voice/stt";
import { LiveTranscriber, liveSttUnavailable, prewarmLiveStt, relayUrl } from "@/lib/voice/live-stt";
import { fetchFixedSpeech, fetchSpeech, playBlob, speakBrowser, type TtsMode } from "@/lib/voice/tts";
import { isPlaybackPaused, pausePlayback, resumePlayback } from "@/lib/voice/playback";
import BoardMenu, { useBoardMenu } from "./BoardMenu";
import BoardPager from "./BoardPager";
import ClassSubjectPicker from "./ClassSubjectPicker";
import Composer, { joinDictation } from "./Composer";
import { LogoTile, Wordmark } from "./Logo";
import LanguageMenu from "./LanguageMenu";
import StartScreen from "./StartScreen";
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

export type Status = "idle" | "listening" | "transcribing" | "thinking" | "teaching" | "asking";
// Only real student text and Indica's replies live here. The lesson's internal
// "next step" nudges are never messages: they exist in the request history the
// lesson pipeline keeps, which runs ahead of the transcript by design.
export type ChatMessage = HistoryMessage & { id: string; pending?: boolean };

/**
 * The staged lesson state machine (see lib/schema.ts `TutorMode`):
 *   none            — no lesson yet; the next topic starts one
 *   awaitFamiliarity— asked the familiarity question, waiting for the answer
 *   teaching        — teaching the plan step by step (Ultra)
 *   checkpoint      — a step just finished; asked "any doubt?" and waiting for the answer
 *   doubt           — answering a student's doubt on its own new page (fast doubt model), paused
 */
export type LessonPhase = "none" | "awaitFamiliarity" | "teaching" | "checkpoint" | "doubt";

// A statement turn ends "ready to continue"; a question turn ends on "?". We use
// the last character of the spoken reply to tell the two apart.
const isQuestionEnding = (t: string) => /[?？]\s*$/.test(t.trim());
// Hidden user turn that asks the model to teach the next small step. Phrased as
// plain language so the model (which mirrors the student's language) just carries on.
/**
 * The request that opens a lesson step. It NAMES the step rather than saying
 * "continue": a step that ended on a promise ("Let us now compute all six
 * ratios") read "Continue to the next step." as "finish that", and the fast
 * model then stayed one step behind its headings for the rest of the lesson —
 * the 30°/60° triangle under "7. Ratios for 0° and 90°", 0° taught twice, and
 * the last three steps never taught at all.
 */
function stepNudge(plan: LessonPlan, i: number): string {
  if (i === 0) return "Begin the lesson.";
  const title = stripStepNumber(plan.steps[i]?.title ?? "") || `step ${i + 1}`;
  return `Now teach step ${i + 1} of ${plan.steps.length}: "${title}". Step ${i} is over, even if it stopped short — do not finish it or repeat it. Start "${title}" from its beginning.`;
}
export type Config = {
  llm: string | null;
  stt: SttMode;
  tts: TtsMode;
  /** How fast Indica speaks, as a multiplier (server-side TTS_PACE). */
  ttsPace: number;
  /** Which backend can stream words while the student is still speaking. */
  liveStt: "sarvam" | "browser" | null;
  sttRelayUrl: string | null;
  sttRelayPort: number;
};
const FALLBACK_CONFIG: Config = {
  llm: null,
  stt: "browser",
  tts: "browser",
  ttsPace: 0.9,
  liveStt: "browser",
  sttRelayUrl: null,
  sttRelayPort: 8787,
};
/**
 * A beat waiting its turn to be spoken — the "temporary cache" the staged lesson
 * runs on. `step` is the plan step it belongs to (AGENDA_STEP for the spoken
 * roadmap) and `turn` tags what it draws, so one step can be wiped and re-taught
 * after a doubt without touching the others.
 */
type QueuedBeat = {
  beat: Beat;
  audio: Promise<Blob | null> | null;
  /** The server-laid question block of a solve turn: drawn with
   *  `drawQuestionBlock`, which keeps the model's solution below it. */
  question?: boolean;
};
/** A queued beat inside a lesson run, tagged with where it belongs. */
type QueuedStepBeat = QueuedBeat & { step: number; turn: number };

/**
 * A lesson run that survives being interrupted.
 *
 * A doubt used to abort the whole pipeline, and coming back re-asked the model
 * for the interrupted step — 5-12 seconds of silence on a blank page, because
 * the half-drawn step had to be wiped before it could be taught again. But
 * nothing about a paused run is stale: its beats are generated, their speech is
 * fetched, and the page they belong on is still there. So an interruption now
 * stops only PLAYBACK. Generation carries on in the background (the lookahead
 * gate keeps it one step ahead, as always), and the resume starts speaking
 * again from the very beat it was cut off on.
 */
type LessonRun = {
  /** Aborts GENERATION — the producer loop and its speech prefetch. A doubt
   *  leaves this alone; only `discardRun` (a new topic, a new plan) fires it. */
  gen: AbortController;
  queue: AsyncQueue<QueuedStepBeat>;
  gate: StepGate;
  /** The live consumer, so a resume can wait for the paused one to let go. */
  playing: Promise<void> | null;
  /** The beat playback was cut off in, and the element ids it had drawn by
   *  then. Spoken again from its start when the lesson resumes. */
  held: { q: QueuedStepBeat; drawn: string[] } | null;
  /** The step on the air and the transcript bubble it is writing into. Both
   *  outlive the pause: without them a resume would start a new page and a
   *  second bubble half-way through a step. */
  step: number;
  bubble: string;
  /** Bubbles this run wrote, so `catchUp` can tell the student's doubts (worth
   *  adding to the request history) from the run's own text (already there). */
  ownIds: Set<string>;
  /** True once the producer has pushed its last beat. */
  done: boolean;
  /**
   * Set while the consumer is parked at a checkpoint between two steps, and
   * resolved by the student's answer (see `clearCheckpoint`).
   *
   * The consumer waits on this; the PRODUCER is deliberately left running, so
   * the step behind the checkpoint keeps being fetched while the student
   * thinks. That is what makes "no doubt, carry on" instant: the beats and
   * their speech are already in the queue, exactly as they are across a doubt.
   */
  checkpoint: { done: Promise<void>; release: () => void; signal: AbortSignal } | null;
};

/** The spoken roadmap, queued like a step but generated locally from the plan. */
const AGENDA_STEP = -1;
/**
 * How many steps may be generated ahead of the one being spoken. One is enough
 * and more is waste: a step takes 25-40s to speak and 5-12s to generate, so a
 * single step of lookahead already hides the whole wait — and anything further
 * ahead is likely to be thrown away by the next doubt.
 */
const LOOKAHEAD_STEPS = 1;
/** Requests per lesson step before an empty answer stops the lesson. */
const STEP_ATTEMPTS = 2;

const STATUS_LABEL: Record<Status, string> = {
  idle: "Ready",
  listening: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Indica is thinking…",
  teaching: "Indica is teaching…",
  asking: "Indica is asking you something…",
};

/**
 * Whether Esc means anything right now. It interrupts a lesson in flow; it has
 * nothing to interrupt while Indica is putting a question TO the student and
 * waiting on the answer, and offering it there told them to cancel their own turn.
 */
const INTERRUPTIBLE: Record<Status, boolean> = {
  idle: false,
  listening: false,
  transcribing: false,
  thinking: true,
  teaching: true,
  asking: false,
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

function KeyboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 9.5h.01M9.5 9.5h.01M13 9.5h.01M16.5 9.5h.01M6 13h.01M18 13h.01M9.5 13h5" strokeLinecap="round" />
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

/**
 * The planning screen. Designing a lesson is the one call in the app that takes
 * real time (the planner reasons, on purpose), and a tutor that goes quiet and
 * still for half a minute reads as broken. So the wait shows the work: each step
 * title lands the moment the planner finishes writing it, with a pending row
 * below for the one being written. Indica is talking over this.
 */
function PlanningCard({ steps }: { steps: (string | undefined)[] }) {
  // Always one more row than we have, so the list visibly has somewhere to go.
  const rows = Math.min(6, Math.max(steps.length + 1, 4));
  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-6">
      <div
        aria-live="polite"
        className="w-full max-w-md rounded-2xl border border-amber-200/50 bg-[#fffdf7]/85 p-5 shadow-xl shadow-amber-900/10 backdrop-blur-sm"
      >
        <div className="flex items-center gap-2.5">
          <span className="flex gap-1" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-amber-500"
                style={{ animationDelay: `${i * 160}ms` }}
              />
            ))}
          </span>
          <p className="text-sm font-semibold text-amber-900">Planning your lesson…</p>
        </div>
        <ul className="mt-4 space-y-2.5">
          {Array.from({ length: rows }, (_, i) => {
            const title = steps[i];
            return (
              <li key={i} className="flex items-center gap-2.5 text-[13px]">
                <span
                  className={
                    "grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold " +
                    (title ? "bg-amber-500 text-white" : "bg-amber-200/60 text-amber-700/70")
                  }
                >
                  {i + 1}
                </span>
                {title ? (
                  <span className="text-neutral-700">{title}</span>
                ) : (
                  <span
                    aria-hidden
                    className="h-3 animate-pulse rounded-full bg-amber-200/50"
                    style={{ width: `${58 - i * 6}%` }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
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
  // Which pipeline the student picked before their first question. "learn" is the
  // staged lesson (familiarity → plan → steps); "solve" goes straight to a worked
  // solution with no plan stage. Null until they choose.
  const [track, setTrack] = useState<TutorTrack | null>(null);
  const trackRef = useRef<TutorTrack | null>(null);
  useEffect(() => {
    trackRef.current = track;
  }, [track]);
  // Solve-track state: the question currently on the board, so a mid-solution doubt
  // can be answered in its context and "next" knows what was just solved.
  const solveRef = useRef<{ question: string | null; label: string | null; solved: boolean }>({
    question: null,
    label: null,
    solved: false,
  });
  // Mirrored for render (the composer's placeholder changes once something is on the
  // board); the ref stays the source of truth for the async turn callbacks.
  const [solveStarted, setSolveStarted] = useState(false);
  // The planner is thinking. Designing a lesson is the one genuinely slow call
  // in the app, so the wait gets a screen of its own — and `planOutline` fills
  // it with the real steps as the planner writes them, so the student is
  // watching progress rather than a spinner.
  const [planning, setPlanning] = useState(false);
  const [planOutline, setPlanOutline] = useState<string[]>([]);
  // Same titles, readable from the async filler loop without waiting for a render:
  // the filler reads them out once the written lines run out (see `speakLines`).
  const planOutlineRef = useRef<string[]>([]);
  // True from the first teaching turn until the topic is dropped. Distinct from
  // phase "teaching", which is already set while the plan is being designed —
  // there is nothing on the board to have a doubt about until a step runs.
  const [lessonStarted, setLessonStarted] = useState(false);
  // The student pressed Doubt and the mic is opening. Tracked separately from
  // lessonPhase because nothing is sent to ask() until they actually speak, and
  // the button must disappear the instant it is pressed.
  const [doubtPending, setDoubtPending] = useState(false);
  /**
   * True while the lesson is parked on the plain "any doubt?" gate, which is
   * answered with the Yes/No buttons rather than by guessing at a sentence.
   *
   * Only the plain gate: when the checkpoint put a REAL question ("what is b?"),
   * the answer is the student's own words and there is nothing for a Yes/No pair
   * to mean, so the buttons stay away and the mic does its job.
   *
   * State, not a ref, because two buttons render from it.
   */
  const [gateOpen, setGateOpen] = useState(false);
  // The last teaching turn and which step it was drawing, so an interrupted
  // step's content can be wiped before that step is taught again.
  const lastTeachRef = useRef<{ turn: number; step: number } | null>(null);
  // The lesson run in flight, or the one paused on a doubt waiting to be picked
  // back up. See `LessonRun`.
  const runRef = useRef<LessonRun | null>(null);
  const setLesson = useCallback((p: LessonPhase) => {
    lessonRef.current.phase = p;
    setLessonPhase(p);
    if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
      // Mirrors useVoiceLoop's __guruVoicePhase: the staged lesson is driven by
      // speech and timers, so a smoke test has no other way to see which stage
      // it reached. Dev only.
      const w = window as unknown as { __guruLessonPhase?: LessonPhase; __guruPhaseLog?: LessonPhase[] };
      w.__guruLessonPhase = p;
      (w.__guruPhaseLog ??= []).push(p);
    }
  }, []);
  /**
   * Opens the mic straight away, with no keypress from the student.
   *
   * A ref because the thing that does it — the voice loop — is set up further
   * down the component, while `askCheckpoint` (above) is what needs to call it.
   * In chat mode it stays a no-op: there is a composer waiting, and grabbing the
   * mic of a student who is typing would be worse than asking them to type.
   */
  const openMicRef = useRef<() => void>(() => {});
  /**
   * True while a doubt is being answered that was raised AT a checkpoint (as
   * opposed to barged in mid-step).
   *
   * The two resume along different paths — a checkpoint doubt releases the
   * consumer still parked between the steps, a mid-step doubt starts a fresh
   * one on the held beat — and by the time "got it" arrives the phase is
   * "doubt" either way, so where the lesson was interrupted has to be
   * remembered here.
   */
  const checkpointDoubtRef = useRef(false);
  /**
   * Set when the student pressed "I have a doubt" at the gate. Whatever they say
   * next is then taken as the doubt, with no sentence classification at all —
   * they have already told us which it is, so re-deciding from their words could
   * only overrule them. Cleared as soon as that utterance is routed.
   */
  const gateForcedDoubtRef = useRef(false);
  /**
   * How the student has been doing at the checkpoints: the signal the model
   * reads to decide whether to ask anything, and how hard (see
   * `buildCheckpointPrompt`). Lives for the lesson and resets with it.
   *
   * A ref, not state, because nothing renders from it — it is read inside async
   * callbacks at the moment a checkpoint fires, where a stale closure over
   * state would hand the model the record from two steps ago.
   */
  const recordRef = useRef<LessonRecord>({
    asked: 0,
    correct: 0,
    partial: 0,
    wrong: 0,
    doubts: 0,
    sinceAsked: 0,
    recent: [],
    lastDifficulty: null,
  });
  /** The question in flight at a checkpoint, so the answer can be graded
   *  against it. Null whenever the checkpoint is a plain "any doubt?". */
  const pendingQuestionRef = useRef<{ question: string; expected: string; difficulty: "recall" | "apply" | "stretch"; step: number } | null>(null);
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
          await speakBrowser(
            say,
            lang,
            signal,
            (charIndex) => advance(say.slice(0, charIndex).split(/\s+/).filter(Boolean).length),
            configRef.current?.ttsPace,
          );
        }
      } else {
        begin();
        startPacer();
        await speakBrowser(
          say,
          lang,
          signal,
          (charIndex) => advance(say.slice(0, charIndex).split(/\s+/).filter(Boolean).length),
          configRef.current?.ttsPace,
        );
      }
    } finally {
      if (pacer) clearInterval(pacer);
      // Speech is over: push the word index past the end so no word renders as
      // "being spoken" while the beat's drawing animation finishes.
      setLiveCaption((c) => (c && c.id === id ? { id, text: say, word: nWords } : c));
    }
  }, []);

  /** Consumer: plays beats in order, drawing and speaking each one concurrently.
   *  `speaking` is the status to show while it runs: teaching by default, but
   *  "asking" for a turn that puts a question to the student and then waits. */
  const playQueue = useCallback(
    async (
      queue: AsyncQueue<QueuedBeat>,
      turn: number,
      assistantId: string,
      signal: AbortSignal,
      speaking: Status = "teaching",
    ) => {
      const player = boardRef.current?.player;
      if (!player) return;
      let first = true;
      for await (const { beat, audio, question } of queue) {
        if (signal.aborted) break;
        if (first) {
          setStatus(speaking);
          first = false;
        }
        setMessages((m) =>
          m.map((x) => (x.id === assistantId ? { ...x, text: x.text ? `${x.text} ${beat.say}` : beat.say } : x)),
        );
        // Mirror the accumulating reply into a ref so the voice loop can inspect
        // how this turn ended without waiting on the messages state to settle.
        turnTextRef.current = turnTextRef.current ? `${turnTextRef.current} ${beat.say}` : beat.say;
        const draw = question
          ? player.drawQuestionBlock(beat.draw ?? [], turn, signal)
          : player.applyBeat(beat.draw ?? [], turn, signal);
        await Promise.all([draw, speakBeat(beat, audio, signal)]);
      }
    },
    [speakBeat],
  );

  /**
   * One self-contained model-backed turn: it builds the board summary, posts to
   * /api/tutor with the stage `mode`, and streams beats onto the board, start to
   * finish. `interrupt` puts the turn on its own new page (a doubt, or a
   * textbook-example detour).
   *
   * The staged lesson does NOT come through here — it runs as one long pipelined
   * turn (`startLessonRun`), because its steps have to be generated ahead of
   * being spoken, and a turn that owns its own playback can't overlap with the
   * next.
   */
  const runTurn = useCallback(
    async (spec: {
      text: string;
      mode: "doubt" | "explain" | "ask" | "solve" | "solvedoubt";
      /** Draw this turn on its own NEW page: a doubt, or an explain detour. Both
       *  are interruptions whose content stays off the teaching page and is
       *  skipped when teaching resumes. */
      interrupt?: boolean;
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
      // Decide the page BEFORE summarising, so the model is told about the page
      // it is actually going to draw on. An interruption gets a page of its own;
      // teaching continues the current page while it has room.
      if (spec.interrupt) b.player.beginDoubtTurn();
      // A solve turn always takes a clean sheet. Its question block is laid out
      // server-side at fixed coordinates from the top of the page, so it cannot
      // be pushed below whatever the previous question left behind — share a
      // page and the new heading prints straight over the old one.
      else b.player.beginTeachTurn({ stayOnPage: changed.length > 0, freshPage: spec.mode === "solve" });
      const canvas = b.summarizeScene(elements, new Set(changed.map((e) => e.id)), b.player.pageFrame());

      const userMsg: ChatMessage = { id: uid("u"), role: "user", text: spec.text };
      const assistantId = uid("a");
      const history = [...messagesRef.current.filter((m) => !m.pending), userMsg];
      setMessages([...history, { id: assistantId, role: "assistant", text: "", pending: true }]);
      setStatus("thinking");

      const queue = new AsyncQueue<QueuedBeat>();
      const playing = playQueue(queue, turn, assistantId, ac.signal);

      try {
        await postTutorTurn(
          {
            messages: history.slice(-12).map((m) => ({ role: m.role, text: m.text })),
            canvas,
            language: lang,
            // Class + subject name the NCERT textbook; the RAG backend uses this
            // pair to restrict retrieval to that book's embeddings.
            grade: gradeRef.current,
            subject: subjectRef.current,
            mode: spec.mode,
            plan: lessonRef.current.plan ?? undefined,
            familiarity: lessonRef.current.familiarity ?? undefined,
            track: trackRef.current ?? undefined,
            // On a doubt mid-solution, what is being solved is the context the
            // model needs in place of a lesson plan.
            solving: spec.mode === "solvedoubt" ? (solveRef.current.question ?? undefined) : undefined,
          },
          ac.signal,
          (ev) => {
            if (ev.type === "question") {
              // The server laid the question out itself (no LLM). Draw it at once,
              // silently, so the board shows the problem while the model works.
              solveRef.current.question = ev.question;
              solveRef.current.label = ev.label;
              queue.push({ beat: ev.beat, audio: null, question: true });
            } else if (ev.type === "beat") {
              // Prefetch speech the moment a beat arrives so audio is ready when its turn comes.
              const audio =
                cfg.tts === "sarvam"
                  ? fetchSpeech(ev.beat.say, ev.beat.lang || lang, ac.signal, cfg.ttsPace).catch(() => null)
                  : null;
              queue.push({ beat: ev.beat, audio });
            } else if (ev.type === "plan") {
              lessonRef.current.plan = ev.plan;
              lessonRef.current.topic = ev.plan.topic || lessonRef.current.topic;
            } else if (ev.type === "error") {
              setError(ev.message);
            }
          },
        );
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
        // Same policy as stopTurn: a reply that produced no text (a model error,
        // say) disappears instead of leaving an empty bubble.
        setMessages((m) => m.flatMap((x) => (x.id === assistantId ? (x.text ? [{ ...x, pending: false }] : []) : [x])));
        setLiveCaption(null);
        setStatus("idle");
        resumePlayback();
        setSpeechPaused(false);
      }
    },
    [playQueue, stopTurn],
  );

  /**
   * Play tutor beats we generated locally (no API): the fixed familiarity
   * question. Its speech is cached across lessons, like the planning filler —
   * the student hears this same sentence at the start of every topic.
   */
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
      b.player.beginTeachTurn();

      const userMsg: ChatMessage = { id: uid("u"), role: "user", text: userText };
      const assistantId = uid("a");
      const history = [...messagesRef.current.filter((m) => !m.pending), userMsg];
      setMessages([...history, { id: assistantId, role: "assistant", text: "", pending: true }]);
      setStatus("thinking");

      const queue = new AsyncQueue<QueuedBeat>();
      // This turn exists to ASK the student (the familiarity question) and then
      // wait for them, so the status chip must not claim to be teaching.
      const playing = playQueue(queue, turn, assistantId, ac.signal, "asking");
      for (const beat of beats) {
        const audio =
          cfg.tts === "sarvam"
            ? fetchFixedSpeech(beat.say, beat.lang || languageRef.current, cfg.ttsPace)
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

  /**
   * Speaks local lines one after another, stopping early (between lines, never
   * mid-sentence) once `until` settles. This is what covers the planner's
   * thinking time: Indica says what it is doing instead of going silent.
   *
   * The written lines are not sized to the worst wait and cannot be — a plan can
   * take two minutes, and no fixed script is honest for that long in twelve
   * languages. So when they run out, `more()` is asked for another line: the
   * planner publishes step titles as it writes them, and reading those out is
   * real lesson content, in the student's language, that grows as the wait does.
   * Only if there is nothing new to say at all does it fall silent — by then the
   * student has heard the whole outline, which is a reasonable place to pause.
   */
  const speakLines = useCallback(
    async (
      lines: readonly string[],
      signal: AbortSignal,
      until?: Promise<unknown>,
      more?: () => string | null,
    ) => {
      let ready = false;
      const mark = () => {
        ready = true;
      };
      void until?.then(mark, mark);
      const cfgFor = () => configRef.current ?? FALLBACK_CONFIG;
      const say = async (line: string) => {
        const cfg = cfgFor();
        const lang = languageRef.current;
        const audio = cfg.tts === "sarvam" ? fetchFixedSpeech(line, lang, cfg.ttsPace) : null;
        await speakBeat({ say: line, lang, draw: [] }, audio, signal);
      };
      for (const line of lines) {
        if (signal.aborted || ready) return;
        await say(line);
      }
      while (!signal.aborted && !ready) {
        const line = more?.();
        if (!line) return;
        await say(line);
      }
    },
    [speakBeat],
  );

  /**
   * Plan mode, fetch only: no board, no page, no transcript bubble — the planner
   * draws nothing and says nothing. Kept apart from runTurn precisely so filler
   * speech can run alongside it instead of being cancelled by it, and reports
   * each step as the planner finishes writing it so the waiting screen fills in.
   */
  const designPlan = useCallback(
    async (history: HistoryMessage[], signal: AbortSignal): Promise<LessonPlan | null> => {
      const out: { plan: LessonPlan | null } = { plan: null };
      try {
        await postTutorTurn(
          {
            messages: history.slice(-12),
            canvas: "",
            language: languageRef.current,
            grade: gradeRef.current,
            subject: subjectRef.current,
            mode: "plan",
            familiarity: lessonRef.current.familiarity ?? undefined,
          },
          signal,
          (ev) => {
            if (ev.type === "planstep") {
              setPlanOutline((s) => {
                const next = [...s];
                next[ev.index] = ev.step.title;
                planOutlineRef.current = next;
                return next;
              });
            } else if (ev.type === "plan") {
              out.plan = ev.plan;
            } else if (ev.type === "error") {
              setError(ev.message);
            }
          },
        );
      } catch (err) {
        if (!signal.aborted) setError(err instanceof Error ? err.message : String(err));
      }
      return out.plan;
    },
    [],
  );

  /**
   * Stop between two steps, ask whether anything needs clearing up, and wait
   * for the answer.
   *
   * The question is SPOKEN and nothing else: `draw: []`, so not a mark lands on
   * the board. The step's working stays the last thing on the page, which is
   * what the student flips back to later — a stranded "any doubts?" under it
   * would be noise in the notes.
   *
   * It then opens the mic by itself (voice mode): the student does not press
   * anything to answer a question they were just asked out loud. `ask` routes
   * what comes back — `isCheckpointClear` means carry on, anything else is a
   * doubt — and either way `clearCheckpoint` releases the promise this parks on.
   *
   * The run is NOT discarded and the producer is NOT stopped, so the next step
   * is being fetched (and its speech with it) throughout the pause.
   */
  const askCheckpoint = useCallback(
    async (run: LessonRun, signal: AbortSignal) => {
      if (signal.aborted) return;
      const lang = languageRef.current;
      const cfg = configRef.current ?? FALLBACK_CONFIG;
      const L = lessonRef.current;
      // Ask the model what this gap is for: let the lesson run on, or put a real
      // question to the student. It reads the running record, so the answer is
      // adaptive — a student who is cruising gets asked more and harder, one who
      // is struggling gets taught instead. It runs in the gap the student is
      // already pausing in, on the fast tier with thinking off, so the wait is
      // sub-second; and any failure comes back as null, which simply means the
      // plain "any doubt?" gate.
      let decision: CheckpointPlan | null = null;
      if (L.plan) {
        try {
          await postTutorTurn(
            {
              messages: messagesRef.current.filter((m) => !m.pending).slice(-6).map((m) => ({ role: m.role, text: m.text })),
              language: lang,
              grade: gradeRef.current,
              subject: subjectRef.current,
              mode: "checkpoint",
              plan: L.plan,
              step: run.step,
              record: recordRef.current,
              familiarity: L.familiarity ?? undefined,
            },
            signal,
            (ev) => {
              if (ev.type === "checkpoint") decision = ev.plan;
            },
          );
        } catch {
          /* the gate below is the fallback */
        }
      }
      if (signal.aborted) return;
      const asking: CheckpointPlan | null =
        decision && (decision as CheckpointPlan).action === "ask" ? (decision as CheckpointPlan) : null;
      // A real question replaces the "any doubt?" gate for this gap; the record
      // remembers which it was, so the answer is routed to the grader rather
      // than the doubt model.
      pendingQuestionRef.current = asking
        ? { question: asking.question, expected: asking.expected, difficulty: asking.difficulty, step: run.step }
        : null;
      const line = asking ? asking.question : checkpointQuestion(lang);
      const rec = recordRef.current;
      if (asking) {
        rec.asked += 1;
        rec.sinceAsked = 0;
        rec.lastDifficulty = asking.difficulty;
        console.info(`[lesson] checkpoint: ASK (${asking.difficulty}) — ${asking.why}`);
      } else {
        rec.sinceAsked += 1;
        if (decision) console.info(`[lesson] checkpoint: continue — ${(decision as CheckpointPlan).why}`);
      }
      let release = () => {};
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The signal travels with the record so the handover line that releases
      // this checkpoint is spoken against the run's own lifetime: if the run is
      // discarded while the student is answering, that line is cut off too.
      run.checkpoint = { done, release, signal };
      // Torn down while parked: let the consumer go rather than leave it waiting
      // on an answer that is never coming.
      signal.addEventListener("abort", release, { once: true });
      setLesson("checkpoint");
      // "asking", not "teaching": the status chip must not claim to be teaching
      // while the floor belongs to the student.
      setStatus("asking");
      // A real question is unique to this moment, so it is fetched like any
      // spoken beat; the fixed "any doubt?" gate goes through the FIXED-speech
      // cache, which is what makes it instant after the first lesson.
      const audio =
        cfg.tts !== "sarvam"
          ? null
          : asking
            ? fetchSpeech(line, lang, signal, cfg.ttsPace).catch(() => null)
            : fetchFixedSpeech(line, lang, cfg.ttsPace);
      // A real question belongs in the transcript — it is teaching, and the
      // student should be able to read it back. The plain gate does not: it is
      // the same sentence every step and would bury the lesson in repeats.
      if (asking) {
        const qid = uid("a");
        run.ownIds.add(qid);
        setMessages((m) => [...m, { id: qid, role: "assistant", text: line }]);
      }
      await speakBeat({ say: line, lang, draw: [] }, audio, signal);
      if (signal.aborted) {
        setGateOpen(false);
        signal.removeEventListener("abort", release);
        run.checkpoint = null;
        return;
      }
      // The question has been asked, so hand the floor over: idle is what the
      // voice loop's resume effect watches for, and it is also what lets the
      // chat-mode composer accept an answer.
      setStatus("idle");
      // The plain gate is answered by the Yes/No buttons; a real question is not.
      if (!asking) setGateOpen(true);
      // Let go of `turnRef` for the duration of the pause, while keeping our own
      // `signal`. Everything the student can do next — raise a doubt, ask for an
      // example, start a new topic — goes through `stopTurn()`, which aborts
      // whatever `turnRef` points at; and until now that has been THIS run's
      // controller, because `startLessonRun` holds it for the whole of
      // `playLesson`. Leaving it there would mean a doubt at a checkpoint
      // aborted the very run it is pausing, throwing away the buffered step the
      // pause exists to preserve. A mid-step doubt still aborts the run as
      // before — there the interruption is the point.
      const parked = turnRef.current;
      if (parked && parked.signal === signal) turnRef.current = null;
      // The mic opens ONLY for a real question, where the answer has to be
      // spoken. The plain gate is answered by its two buttons, and opening the
      // mic alongside them says two contradictory things at once: it asks the
      // student to speak while showing them what to press, and then has to
      // guess which of the two they meant. The buttons exist precisely so that
      // nothing has to be guessed — see `isCheckpointClear`, which got "no, we
      // can move forward" wrong because of the comma.
      if (asking) openMicRef.current();
      await done;
      setGateOpen(false);
      signal.removeEventListener("abort", release);
      run.checkpoint = null;
      // Take the turn back, unless something else has claimed it in the
      // meantime (a doubt's controller, say) — whoever holds it now owns the
      // floor, and the handover line has already been spoken against it.
      if (parked && !parked.signal.aborted && turnRef.current === null) turnRef.current = parked;
    },
    [setLesson, speakBeat],
  );

  /**
   * Consumer of the lesson pipeline: speaks and draws queued beats in order,
   * one page per step. Everything about "where are we in the lesson" is decided
   * here rather than at generation time, because the student is only ever where
   * the voice is — generation has already run ahead.
   *
   * It can be stopped and started again on the SAME run: on an interruption it
   * leaves the beat it was cut off on in `run.held` (with the element ids that
   * beat had managed to draw) and lets go of the queue, and the next consumer
   * replays that beat from its start before carrying on. Nothing in between is
   * re-fetched and nothing already on the page is redrawn.
   */
  const playLesson = useCallback(
    async (run: LessonRun, signal: AbortSignal) => {
      const player = boardRef.current?.player;
      if (!player) return;
      // A consumer that walks away while parked on the queue must let go of it,
      // or the beat pushed next is handed to its abandoned promise and lost.
      const detach = () => run.queue.detach();
      signal.addEventListener("abort", detach, { once: true });
      // Drop a step's bubble if it never got any text, like runTurn does.
      const settle = () => {
        const id = run.bubble;
        if (!id) return;
        setMessages((m) => m.flatMap((x) => (x.id === id ? (x.text ? [{ ...x, pending: false }] : []) : [x])));
      };

      /** Speak and draw one beat. `replay` means its words are already in the
       *  transcript — the student only half heard them, so they are said again. */
      const play = async (q: QueuedStepBeat, replay: boolean) => {
        if (q.step !== run.step) {
          // The previous step has been spoken in full, so a resume starts after it.
          if (run.step >= 0) lessonRef.current.step = run.step + 1;
          settle();
          // A subtopic has just ended and the next one is in hand: stop and ask
          // whether anything needs clearing up before it starts. Nothing is
          // thrown away by waiting — `q` is held right here and the producer
          // carries on behind it — so whichever way the student answers, the
          // next step starts speaking the moment they have finished.
          if (run.step >= 0 && q.step >= 0) {
            await askCheckpoint(run, signal);
            // Torn down while parked (the student started something else): this
            // beat has not been spoken or drawn, so hold it exactly as an
            // interrupted beat is held. Without this it would be the one beat
            // the queue has already handed out and the resume never replays —
            // the next step would open on its second sentence.
            if (signal.aborted) {
              run.held = { q, drawn: [] };
              return;
            }
          }
          run.step = q.step;
          // This step is on the air now — free the lookahead slot so the producer
          // can go and fetch the next one while this one is being spoken.
          // Something of Indica's is on the board from here on, roadmap
          // included, so the student can break in on it.
          setLessonStarted(true);
          if (q.step >= 0) {
            run.gate.release();
            // Where the lesson stands, should the buffered run ever be thrown
            // away and this step have to be asked for again.
            lessonRef.current.step = q.step;
            lastTeachRef.current = { turn: q.turn, step: q.step };
          }
          setStatus("teaching");
          // A step is a whole subtopic, so it always opens a page of its own —
          // and gets its numbered heading written at the top before any of the
          // model's own beats land on it.
          player.beginTeachTurn({ newStep: true });
          if (q.step >= 0) {
            const title = lessonRef.current.plan?.steps[q.step]?.title?.trim();
            if (title) {
              // Drawn as a beat of this turn, silently (no `say`), so it is
              // measured like everything else and is erased with the step if
              // the step is ever replayed (`dropTurn`).
              //
              // `drawStepHeading`, not `applyBeat`: it also RESERVES the band
              // the heading occupies, so the step's own first beat starts below
              // the rule. The model is told its page is blank and writes from
              // CONTENT_TOP — the heading's own y — so without that reservation
              // the first line of working lands on top of the title.
              await player.drawStepHeading(stepHeadingOps(q.step, title), q.turn, signal);
              if (signal.aborted) return;
            }
          }
          run.bubble = uid("a");
          const id = run.bubble;
          run.ownIds.add(id);
          setMessages((m) => [...m, { id, role: "assistant", text: "", pending: true }]);
        }
        if (!replay) {
          const id = run.bubble;
          setMessages((m) =>
            m.map((x) => (x.id === id ? { ...x, text: x.text ? `${x.text} ${q.beat.say}` : q.beat.say } : x)),
          );
          turnTextRef.current = turnTextRef.current ? `${turnTextRef.current} ${q.beat.say}` : q.beat.say;
        }
        const [drawn] = await Promise.all([
          player.applyBeat(q.beat.draw ?? [], q.turn, signal),
          speakBeat(q.beat, q.audio, signal),
        ]);
        // Cut off part-way: hold this beat (and what it drew) for the resume.
        run.held = signal.aborted ? { q, drawn: drawn.map((e) => e.id) } : null;
      };

      // Resuming: the beat the interruption landed in is spoken again from its
      // start, on the page it was always on. Its half-drawn fragment comes off
      // first so the replay does not double it up.
      const held = run.held;
      if (held && !signal.aborted) {
        run.held = null;
        player.dropElements(held.drawn);
        await play(held.q, true);
      }
      for await (const q of run.queue) {
        if (signal.aborted) break;
        await play(q, false);
      }
      signal.removeEventListener("abort", detach);
      // Only a run that reached its end moves the lesson on; an interrupted one
      // is paused, and its step pointer has to keep pointing at the paused step.
      if (!signal.aborted) {
        if (run.step >= 0) lessonRef.current.step = run.step + 1;
        settle();
      }
    },
    [askCheckpoint, speakBeat],
  );

  /**
   * Producer of the lesson pipeline: asks the model for one step at a time and
   * streams its beats (with their speech already being fetched) into the run's
   * queue, from `from` to the end of the plan.
   *
   * It stays exactly one step ahead of the voice, because the lookahead gate is
   * released by the CONSUMER as each step goes on air. That is also what makes
   * it safe to leave running while a doubt is answered: it fills at most one
   * more step and then waits, so the pause is spent generating rather than
   * throwing generated work away.
   */
  const generateLesson = useCallback(
    async (run: LessonRun, plan: LessonPlan, from: number, agenda: LessonPlan | null) => {
      const b = boardRef.current;
      if (!b) return;
      const signal = run.gen.signal;
      const cfg = configRef.current ?? FALLBACK_CONFIG;
      const lang = languageRef.current;
      const voiceFor = (beat: Beat) =>
        cfg.tts === "sarvam"
          ? fetchSpeech(beat.say, beat.lang || lang, signal, cfg.ttsPace).catch(() => null)
          : null;
      try {
        // The roadmap: spoken and written as a contents page straight from the
        // plan, so step 1 is being generated throughout it.
        if (agenda) {
          const turn = ++turnCounter.current;
          for (const beat of agendaBeats(agenda, lang)) {
            run.queue.push({ beat, audio: voiceFor(beat), step: AGENDA_STEP, turn });
          }
        }

        // Request history as GENERATED so far, which runs ahead of what has been
        // spoken — step i+1 must be asked for in the light of step i's text even
        // though the student has not heard it yet.
        const history: HistoryMessage[] = [];
        const seen = new Set<string>();
        /** Fold anything new in the transcript into the request history: the
         *  student's doubts and the answers they got are part of the lesson's
         *  conversation, and the next step is taught in the light of them.
         *  Bubbles this run wrote itself are skipped — `history` already has
         *  their text, from the step that generated it. */
        const catchUp = () => {
          for (const m of messagesRef.current) {
            if (m.pending || seen.has(m.id) || run.ownIds.has(m.id)) continue;
            seen.add(m.id);
            history.push({ role: m.role, text: m.text });
          }
        };
        catchUp();
        // A step is generated while the PREVIOUS step is still being drawn, so
        // how much room that step will leave behind cannot be known here. The
        // step is therefore always described a blank page and writes from its
        // top-left; at playback `beginTeachTurn({ newStep: true })` decides
        // whether it shares the page above it, and `applyBeat` measures each
        // beat, pushes it clear of what is already there and spills it onto a
        // fresh page if it does not fit. The page NUMBER here is only the
        // header's "Page 4 of 4" and is an upper bound — steps that end up
        // sharing a page make the real book shorter. The roadmap takes the
        // first page, so the steps start after it.
        const basePage = b.player.nextTeachPage() + (agenda ? 1 : 0);

        for (let i = from; i < plan.steps.length; i++) {
          await run.gate.waitBelow(LOOKAHEAD_STEPS, signal);
          if (signal.aborted) break;
          run.gate.acquire();
          const turn = ++turnCounter.current;
          const page = basePage + (i - from);
          catchUp();
          history.push({ role: "user", text: stepNudge(plan, i) });
          let said = "";
          let beats = 0;
          // A step that comes back EMPTY is asked for again before the lesson
          // gives up. The single lesson model sometimes misses the server's
          // first-beat watchdog (15s) on one request and answers the next one
          // fine; without a retry, one slow request ended a 12-step lesson at
          // step 5 for good. Only an empty step is retried: once a beat has
          // been queued, re-asking would teach the step twice.
          let failure: string | null = null;
          for (let attempt = 0; attempt < STEP_ATTEMPTS && beats === 0 && !signal.aborted; attempt++) {
            failure = null;
            try {
              await postTutorTurn(
                {
                  messages: history.slice(-12),
                  // Not blank: the step heading is drawn across its top before
                  // these beats play. Told the truth, the model plans its page
                  // for the room it really has instead of spilling the last third.
                  canvas: headedPageCanvas(page, page + 1),
                  language: lang,
                  grade: gradeRef.current,
                  subject: subjectRef.current,
                  mode: "teach",
                  plan,
                  step: i,
                  familiarity: lessonRef.current.familiarity ?? undefined,
                },
                signal,
                (ev) => {
                  if (ev.type === "beat") {
                    beats++;
                    said = said ? `${said} ${ev.beat.say}` : ev.beat.say;
                    run.queue.push({ beat: ev.beat, audio: voiceFor(ev.beat), step: i, turn });
                  } else if (ev.type === "error") {
                    // Mid-step errors are real news; an empty attempt's error
                    // is only shown if the retry fails too.
                    if (beats > 0) setError(ev.message);
                    else failure = ev.message;
                  }
                },
              );
            } catch (err) {
              failure = err instanceof Error ? err.message : String(err);
            }
            if (beats === 0 && failure && attempt + 1 < STEP_ATTEMPTS) {
              console.warn(`[lesson] step ${i + 1} came back empty (${failure}); asking again`);
            }
          }
          if (signal.aborted) break;
          if (beats === 0 && failure) setError(failure);
          history.push({ role: "assistant", text: said || "(drew on the board)" });
          // Nothing came back: this step will never reach the consumer, so the
          // slot it took has to be given back by hand. Stop there rather than
          // marching through a plan the model has stopped answering — the error
          // is already on screen and the step pointer still points here, so
          // "continue" retries it.
          if (beats === 0) {
            run.gate.release();
            break;
          }
        }
      } finally {
        run.done = true;
        run.queue.close();
      }
    },
    [],
  );

  /** Throw a buffered run away: generation stops and its beats are dropped.
   *  Only a real break with the lesson does this — a new topic or a new plan. */
  const discardRun = useCallback(() => {
    const run = runRef.current;
    runRef.current = null;
    if (!run) return;
    run.gen.abort();
    run.queue.close();
    run.held = null;
    // A consumer parked at a checkpoint is waiting on a promise only an answer
    // resolves, and this run will never get one. Release it so it can see the
    // closed queue and finish, instead of being left holding it forever.
    run.checkpoint?.release();
    run.checkpoint = null;
  }, []);

  /**
   * Teaches the plan from the current step to the end on a FRESH run: the step
   * is asked for again from the model. Used to open a lesson, and as the way
   * back when there is no buffered run left to resume (the model stopped
   * answering mid-plan, or the student started something new).
   */
  const startLessonRun = useCallback(
    async (opts?: { controller?: AbortController; agenda?: LessonPlan | null }) => {
      const b = boardRef.current;
      const L = lessonRef.current;
      if (!b || !L.plan || L.phase !== "teaching") return;
      const plan = L.plan;
      const from = L.step;
      if (from >= plan.steps.length) return; // lesson complete; wait for the student

      discardRun();
      // Resuming comes in without a controller and starts its own turn; the
      // opening run shares the controller planning already set up.
      let ac = opts?.controller;
      if (!ac) {
        stopTurn();
        setError(null);
        setInterim("");
        turnTextRef.current = "";
        ac = new AbortController();
        turnRef.current = ac;
      }
      setStatus("thinking");

      // This step is about to be taught from the top again, so anything an
      // earlier attempt left on its page has to come off, or the replay lands
      // on top of it.
      const prev = lastTeachRef.current;
      if (prev && prev.step === from) b.player.dropTurn(prev.turn);

      const run: LessonRun = {
        gen: new AbortController(),
        queue: new AsyncQueue<QueuedStepBeat>(),
        gate: new StepGate(),
        playing: null,
        held: null,
        step: Number.NaN,
        bubble: "",
        ownIds: new Set<string>(),
        done: false,
        checkpoint: null,
      };
      runRef.current = run;
      void generateLesson(run, plan, from, opts?.agenda ?? null);
      run.playing = playLesson(run, ac.signal);
      await run.playing;

      if (turnRef.current === ac) {
        turnRef.current = null;
        const finalText = turnTextRef.current;
        lastTurnRef.current = {
          aborted: false,
          hadText: !!finalText.trim(),
          endedWithQuestion: isQuestionEnding(finalText),
        };
        setLiveCaption(null);
        setStatus("idle");
        resumePlayback();
        setSpeechPaused(false);
      }
    },
    [discardRun, generateLesson, playLesson, stopTurn],
  );

  /**
   * Pick the paused lesson back up. Nothing is re-planned and nothing is
   * re-fetched: the beats were generated before the doubt and their speech with
   * them, so this is instant — one spoken handover line while the board walks
   * back to the lesson page, and then the sentence the doubt cut into, said
   * again in full, continuing down that same page.
   *
   * Falls back to a fresh run only when there is nothing buffered to resume.
   */
  const resumeLesson = useCallback(async () => {
    const run = runRef.current;
    if (!run || (run.done && !run.queue.size && !run.held)) {
      await startLessonRun();
      return;
    }
    stopTurn();
    await run.playing; // the suspended consumer lets go of the queue first
    setError(null);
    setInterim("");
    turnTextRef.current = "";
    const ac = new AbortController();
    turnRef.current = ac;
    setStatus("teaching");
    const cfg = configRef.current ?? FALLBACK_CONFIG;
    const lang = languageRef.current;
    const line = resumeLine(lang);
    await speakBeat(
      { say: line, lang, draw: [] },
      cfg.tts === "sarvam" ? fetchFixedSpeech(line, lang, cfg.ttsPace) : null,
      ac.signal,
    );
    if (ac.signal.aborted) return;
    run.playing = playLesson(run, ac.signal);
    await run.playing;

    if (turnRef.current === ac) {
      turnRef.current = null;
      const finalText = turnTextRef.current;
      lastTurnRef.current = {
        aborted: false,
        hadText: !!finalText.trim(),
        endedWithQuestion: isQuestionEnding(finalText),
      };
      setLiveCaption(null);
      setStatus("idle");
      resumePlayback();
      setSpeechPaused(false);
    }
  }, [playLesson, speakBeat, startLessonRun, stopTurn]);

  /**
   * Leave a checkpoint and let the lesson run on.
   *
   * Unlike `resumeLesson` this does NOT start a consumer: the one parked in
   * `askCheckpoint` never let go of the queue, so all that is needed is the
   * handover line and the release. That is the whole reason a checkpoint is its
   * own phase rather than a doubt with a different question — no re-fetch, no
   * second consumer, no page walk, and the next step is already buffered.
   *
   * `cleared` picks which set of handovers to speak: the student had a doubt and
   * it has been answered, or they had none at all.
   */
  const clearCheckpoint = useCallback(
    async (cleared: boolean, opts?: { silent?: boolean }) => {
      const run = runRef.current;
      const cp = run?.checkpoint;
      if (!run || !cp) {
        // Nothing parked (the run was thrown away under us): fall back to the
        // normal resume, which re-asks for the step if it has to.
        setLesson("teaching");
        await resumeLesson();
        return;
      }
      // NOT stopTurn(): at a checkpoint `turnRef.current` is the lesson run's
      // OWN controller — the consumer is parked inside the `playLesson` call it
      // was given — so aborting it here would tear down the very run this is
      // about to release, throwing away the buffered step and sending the
      // lesson back through a full re-fetch.
      setError(null);
      setInterim("");
      const signal = cp.signal;
      if (signal.aborted) return;
      setLesson("teaching");
      setStatus("teaching");
      // `silent` skips the handover line. Used after a graded answer, where the
      // verdict has just been spoken: following "exactly right, it is minus
      // four" with "great, let us go ahead" is one acknowledgement too many.
      if (!opts?.silent) {
        const cfg = configRef.current ?? FALLBACK_CONFIG;
        const lang = languageRef.current;
        const line = checkpointHandover(lang, cleared);
        await speakBeat(
          { say: line, lang, draw: [] },
          cfg.tts === "sarvam" ? fetchFixedSpeech(line, lang, cfg.ttsPace) : null,
          signal,
        );
        if (signal.aborted) return;
      }
      cp.release();
    },
    [resumeLesson, setLesson, speakBeat],
  );

  /**
   * Mark the answer the student just spoke to a checkpoint question, say the
   * verdict back, and carry on.
   *
   * The reply is NOT a yes/no about doubts, so none of the clear/doubt
   * classifiers apply: the model that asked the question is the one that marks
   * it, against the answer it said it was looking for.
   *
   * What happens next depends on how wrong they were, and that is the point of
   * grading at all:
   *  - right or nearly: say so and release the checkpoint, so the buffered next
   *    step starts immediately. The lesson has lost ten seconds and gained a
   *    retrieval, which is the trade the whole feature exists to make.
   *  - wrong in a way that matters (`reteach`): the correction alone will not do.
   *    The point is taught again as a doubt turn, on its own page, and the
   *    lesson stays parked at this checkpoint until that is cleared — teaching
   *    on over a misunderstanding the next steps build on is how a student ends
   *    up lost without knowing where.
   *
   * Either way the outcome goes into the record, which is what the NEXT
   * checkpoint reads to decide whether to ask again and how hard.
   */
  const gradeAnswer = useCallback(
    async (pending: { question: string; expected: string; difficulty: "recall" | "apply" | "stretch"; step: number }, answer: string) => {
      pendingQuestionRef.current = null;
      const run = runRef.current;
      const cp = run?.checkpoint;
      const signal = cp?.signal;
      const L = lessonRef.current;
      const lang = languageRef.current;
      const cfg = configRef.current ?? FALLBACK_CONFIG;
      // Their answer belongs in the transcript before the verdict does.
      setMessages((m) => [...m, { id: uid("u"), role: "user", text: answer }]);
      setStatus("thinking");

      let grade: AnswerGrade | null = null;
      try {
        await postTutorTurn(
          {
            messages: [{ role: "user", text: answer }],
            language: lang,
            grade: gradeRef.current,
            subject: subjectRef.current,
            mode: "grade",
            plan: L.plan,
            step: pending.step,
            question: pending.question,
            expected: pending.expected,
            answer,
            record: recordRef.current,
          },
          signal ?? new AbortController().signal,
          (ev) => {
            if (ev.type === "grade") grade = ev.grade;
          },
        );
      } catch {
        /* fall through to the neutral default below */
      }
      if (signal?.aborted) return;
      // No verdict from any model: do not guess and do not stall. Count it as
      // partial, say nothing about right or wrong, and let the lesson run on —
      // the student has at least had the retrieval.
      const g: AnswerGrade = grade ?? { verdict: "partial", say: "", reteach: false };
      const rec = recordRef.current;
      if (g.verdict === "correct") rec.correct += 1;
      else if (g.verdict === "partial") rec.partial += 1;
      else rec.wrong += 1;
      rec.recent = [...rec.recent, g.verdict].slice(-5);
      console.info(`[lesson] answer ${g.verdict}${g.reteach ? " (reteach)" : ""} — ${rec.correct}/${rec.asked} right`);

      // Say the verdict. Spoken only: a tick on the board would sit under the
      // step's working for the rest of the lesson.
      const say = g.say.trim();
      if (say && signal && !signal.aborted) {
        setMessages((m) => [...m, { id: uid("a"), role: "assistant", text: say }]);
        setStatus("teaching");
        await speakBeat(
          { say, lang, draw: [] },
          cfg.tts === "sarvam" ? fetchSpeech(say, lang, signal, cfg.ttsPace).catch(() => null) : null,
          signal,
        );
      }
      if (signal?.aborted) return;

      // A miss that matters: teach it again before moving on. The lesson stays
      // parked here, so "got it" comes back through the checkpoint path and the
      // buffered next step is still waiting.
      if (g.reteach) {
        checkpointDoubtRef.current = true;
        setLesson("doubt");
        await runTurn({ text: `I got this wrong: ${pending.question}. Please explain it again.`, mode: "doubt", interrupt: true });
        return;
      }
      // Right, or close enough that the correction did the job: carry on. The
      // verdict has just been spoken, so skip the "great, let's go ahead"
      // handover — two acknowledgements in a row sounds like a stutter.
      await clearCheckpoint(true, { silent: !!say });
    },
    [clearCheckpoint, runTurn, setLesson, speakBeat],
  );

  /**
   * Opens a lesson: design it, then teach it. One turn from the student's point
   * of view, and deliberately so — Indica speaks from about a second after the
   * familiarity answer (filler), through the planner's thinking, into the spoken
   * roadmap, and straight on into step 1, with no silence anywhere in between.
   */
  const startLesson = useCallback(
    async (text: string) => {
      const b = boardRef.current;
      if (!b) return;
      stopTurn();
      setError(null);
      setInterim("");
      turnTextRef.current = "";
      const ac = new AbortController();
      turnRef.current = ac;
      setStatus("thinking");
      setPlanning(true);
      setPlanOutline([]);
      planOutlineRef.current = [];

      // A fresh lesson: nothing of it has been drawn, so there is no interrupted
      // step to wipe. Left over from the previous lesson, this would make the
      // first step drop that lesson's step-1 page instead.
      lastTeachRef.current = null;

      const userMsg: ChatMessage = { id: uid("u"), role: "user", text };
      const history = [...messagesRef.current.filter((m) => !m.pending), userMsg];
      setMessages(history);

      // Planning and filler speech run together: the fetch is the long pole, the
      // filler is what makes the wait listenable.
      const planned = designPlan(
        history.map((m) => ({ role: m.role, text: m.text })),
        ac.signal,
      );
      // Once the written filler runs out, read out the step titles the planner has
      // published so far — each one only ever once, in order. When those run out
      // too (a plan can take two minutes; the titles only start arriving when the
      // planner stops reasoning and starts writing), fall back to short hold lines
      // that bear repeating, so the wait never goes silent however long it runs.
      let spokenSteps = 0;
      let holds = 0;
      const nextStepLine = (): string | null => {
        const outline = planOutlineRef.current;
        while (spokenSteps < outline.length) {
          const title = outline[spokenSteps]?.trim();
          spokenSteps++;
          if (title) return planningStepLead(languageRef.current, spokenSteps, title);
        }
        const pool = planningHolds(languageRef.current);
        return pool.length > 0 ? pool[holds++ % pool.length] : null;
      };
      await speakLines(planningLines(languageRef.current), ac.signal, planned, nextStepLine);
      const plan = await planned;
      setPlanning(false);
      if (ac.signal.aborted) return;

      if (!plan || plan.steps.length === 0) {
        // Planning failed: fall back so the student isn't stuck on a blank board.
        setLesson("none");
        setLessonStarted(false);
        if (turnRef.current === ac) {
          turnRef.current = null;
          setStatus("idle");
        }
        return;
      }
      lessonRef.current.plan = plan;
      lessonRef.current.topic = plan.topic || lessonRef.current.topic;
      lessonRef.current.step = 0;
      await startLessonRun({ controller: ac, agenda: plan });
    },
    [designPlan, speakLines, setLesson, startLessonRun, stopTurn],
  );

  /**
   * The student said/typed something. Routes it through the lesson state machine:
   *   none            → ask the fixed familiarity question (no API), then wait
   *   awaitFamiliarity→ design the lesson, preview it, then teach it step by step
   *   teaching        → treat it as a DOUBT (fast doubt model, side canvas), and pause
   *   doubt           → "got it" resumes the lesson; anything else is another doubt
   */
  const ask = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      setDoubtPending(false);
      if (!text || !boardRef.current) return;
      const L = lessonRef.current;

      // ---- SOLVE track: no familiarity question, no plan, no steps. ----
      // The student named a question, so the first turn already solves it. A reply
      // while a solution is on the board is either "next question" (solve it) or a
      // doubt about the solution (answer it beside, without restarting).
      if (trackRef.current === "solve") {
        if (!solveRef.current.solved) {
          solveRef.current.solved = true;
          setSolveStarted(true);
          setLesson("teaching"); // enables the Doubt affordances; there is no plan to run
          await runTurn({ text, mode: "solve" });
          return;
        }
        // A doubt about the solution just given.
        if (!isNextQuestion(text)) {
          await runTurn({ text, mode: "solvedoubt", interrupt: true });
          return;
        }
        // "next"/"another one" with no question in it: nothing to solve yet.
        solveRef.current.question = null;
        solveRef.current.label = null;
        await runTurn({ text, mode: "solve" });
        return;
      }

      if (L.phase === "none") {
        L.plan = null;
        L.step = 0;
        L.topic = text;
        L.familiarity = null;
        // A new topic is a new record: how they did on quadratics says nothing
        // about how to pitch questions on trigonometry.
        recordRef.current = { asked: 0, correct: 0, partial: 0, wrong: 0, doubts: 0, sinceAsked: 0, recent: [], lastDifficulty: null };
        pendingQuestionRef.current = null;
        setLesson("awaitFamiliarity");
        await playLocalBeats(text, [{ say: familiarityQuestion(languageRef.current), lang: languageRef.current, draw: [] }]);
        return;
      }

      if (L.phase === "awaitFamiliarity") {
        L.familiarity = classifyFamiliarity(text);
        L.step = 0;
        setLesson("teaching");
        await startLesson(text); // design it, preview it, then teach it step by step
        return;
      }

      // Answering the checkpoint question asked after the step that just ended.
      // "No doubt" is the common case and the whole point of the pause: it
      // speaks one acknowledgement and releases the parked consumer, so the
      // next step (already generated, its speech already fetched) starts
      // immediately. Anything else is a doubt, and the lesson comes BACK to the
      // checkpoint once it is answered rather than running straight on — the
      // student who had one question usually has a second.
      if (L.phase === "checkpoint") {
        // They pressed "I have a doubt": this utterance IS the doubt. Skip every
        // classifier — the student has already answered the yes/no, and reading
        // their words again could only contradict the button they just pressed.
        if (gateForcedDoubtRef.current) {
          gateForcedDoubtRef.current = false;
          setGateOpen(false);
          pendingQuestionRef.current = null;
          recordRef.current.doubts += 1;
          checkpointDoubtRef.current = true;
          setLesson("doubt");
          await runTurn({ text, mode: isExplainRequest(text) ? "explain" : "doubt", interrupt: true });
          return;
        }
        const pending = pendingQuestionRef.current;
        // A real question was put to them, so this is an ANSWER to be marked —
        // not a yes/no about doubts. `isCheckpointClear` must not see it: "no"
        // is a perfectly good answer to "is x = 2 a root?" and would otherwise
        // be read as "no doubts, carry on".
        if (pending) {
          // Unless they are plainly asking rather than answering, in which case
          // it is a doubt about the question itself.
          if (!isAnswerDodge(text)) {
            await gradeAnswer(pending, text);
            return;
          }
          pendingQuestionRef.current = null;
          recordRef.current.doubts += 1;
          checkpointDoubtRef.current = true;
          setLesson("doubt");
          await runTurn({ text, mode: "doubt", interrupt: true });
          return;
        }
        if (isCheckpointClear(text) && !isExplainRequest(text)) {
          await clearCheckpoint(false);
          return;
        }
        recordRef.current.doubts += 1;
        checkpointDoubtRef.current = true;
        setLesson("doubt");
        await runTurn({
          text,
          mode: isExplainRequest(text) ? "explain" : "doubt",
          interrupt: true,
        });
        return;
      }

      // Asking for a specific textbook item (example / exercise / theorem) is a
      // teaching detour: Ultra works it on the MAIN canvas. The lesson stays paused
      // afterwards (phase "doubt") so "got it" resumes it, like any interruption.
      if (isExplainRequest(text)) {
        setLesson("doubt");
        await runTurn({ text, mode: "explain", interrupt: true }); // its own page, Ultra
        return;
      }

      if (L.phase === "doubt" && isDoubtCleared(text)) {
        // The doubt page is KEPT, as a neighbour of the lesson page; this walks
        // the camera back left onto the lesson page, which still holds
        // everything taught before the doubt.
        boardRef.current?.player.endDoubt();
        // The doubt was raised AT a checkpoint, so the consumer is still parked
        // there: release it with a "now that's clear, back to where we were"
        // handover instead of taking the mid-step resume path, which would
        // start a second consumer on a queue the first one never let go of.
        if (checkpointDoubtRef.current && runRef.current?.checkpoint) {
          checkpointDoubtRef.current = false;
          await clearCheckpoint(true);
          return;
        }
        checkpointDoubtRef.current = false;
        setLesson("teaching");
        await resumeLesson(); // carries on from the sentence the doubt cut into
        return;
      }

      // The lesson STOPPED — a step the model never answered, even on retry —
      // and the student says "continue". That is a request to carry on, not a
      // doubt: routing it to the doubt model answered "please continue the
      // lesson" on a side page and skipped the step that had failed.
      if (L.phase === "teaching" && L.plan && L.step < L.plan.steps.length && isDoubtCleared(text)) {
        const run = runRef.current;
        const stalled = !turnRef.current && (!run || (run.done && !run.queue.size && !run.held));
        if (stalled && statusRef.current === "idle") {
          setError(null);
          await startLessonRun();
          return;
        }
      }

      // Otherwise it's a conceptual doubt → the doubt model on a new page, lesson paused.
      // Reached from "teaching" (barged in mid-step) or from a "doubt" that was
      // not cleared (a second question). Only the first of those changes how the
      // lesson resumes, and it resumes mid-step — so the checkpoint flag is set
      // from "teaching" and otherwise left alone, since a follow-up question at
      // a checkpoint is still at that checkpoint.
      if (L.phase === "teaching") checkpointDoubtRef.current = false;
      // A doubt is the second signal the checkpoint model reads: a student
      // raising them is a student who should be taught, not quizzed.
      recordRef.current.doubts += 1;
      setLesson("doubt");
      await runTurn({ text, mode: "doubt", interrupt: true });
    },
    [clearCheckpoint, gradeAnswer, playLocalBeats, resumeLesson, runTurn, setLesson, startLesson, startLessonRun],
  );

  // Voice-loop hooks: if a teaching run ended with steps still to go (a step the
  // model failed to answer), carry on from there instead of stalling the lesson.
  const continueLesson = useCallback(() => {
    void startLessonRun();
  }, [startLessonRun]);
  const shouldContinueLesson = useCallback(() => {
    const L = lessonRef.current;
    // Auto-advance only while teaching and there are steps left; the turn must have
    // produced text and not ended on a question (the last step's practice offer).
    if (L.phase !== "teaching" || !L.plan || L.step >= L.plan.steps.length) return false;
    const t = lastTurnRef.current;
    return !t.aborted && t.hadText && !t.endedWithQuestion;
  }, []);
  /** Is the lesson parked at a between-step checkpoint, waiting to be answered?
   *  The voice loop opens the mic by itself when it is (see `autoListen`). */
  /**
   * Should the mic open by itself right now?
   *
   * Only at a checkpoint that asked a REAL question, where the answer has to be
   * spoken. The plain "any doubt?" gate is answered by its two buttons, and a
   * live mic beside them is the app asking and telling at the same time.
   */
  const atCheckpoint = useCallback(
    () => lessonRef.current.phase === "checkpoint" && pendingQuestionRef.current != null,
    [],
  );

  // Hands-free conversation loop for voice mode: greets, listens, end-points
  // the student's sentence, submits it, and listens again after each turn.
  const voice = useVoiceLoop({
    enabled: voiceMode,
    status,
    boardReady: !!board && !!config,
    hasConversation: messages.length > 0,
    ask,
    shouldContinue: shouldContinueLesson,
    autoListen: atCheckpoint,
    continueLesson,
    setInterim,
    setError,
    configRef,
    languageRef,
    trackRef,
  });
  const voicePhaseRef = useRef(voice.phase);
  useEffect(() => {
    voicePhaseRef.current = voice.phase;
  }, [voice.phase]);
  // Give `askCheckpoint` its way to open the mic. The answer then goes through
  // transcribe → review → ask like any other utterance, so nothing reaches the
  // model unseen. Only in voice mode: in chat mode the student answers in the
  // composer, which is already there and waiting.
  useEffect(() => {
    openMicRef.current = voiceMode ? voice.listenForAnswer : () => {};
  }, [voiceMode, voice.listenForAnswer]);

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
    setDoubtPending(true);
    stopTurn();
    voiceBargeIn();
  }, [stopTurn, voiceBargeIn]);

  /**
   * The checkpoint gate's two buttons.
   *
   * These exist because the sentence classifier was the wrong tool for the job.
   * It had to decide, from free text, whether "no, we can move forward" meant
   * "no doubts" or was itself a doubt — and it got that exact sentence wrong,
   * because the comma after "no" broke a regex that wanted whitespace. Patching
   * the pattern would have bought one phrasing; the next one would break it
   * again. The question is a plain yes/no, so the honest interface is a yes and
   * a no, and then nothing has to be guessed at.
   *
   * `isCheckpointClear` stays for the typed and spoken paths — a student may
   * still answer out loud, and the buttons are an addition, not a replacement.
   */
  const gateNoDoubt = useCallback(() => {
    setGateOpen(false);
    // Straight to the handover and the buffered next step. No model call, no
    // classifier, no transcription — this is the fastest path in the lesson.
    void clearCheckpoint(false);
  }, [clearCheckpoint]);

  const gateHaveDoubt = useCallback(() => {
    setGateOpen(false);
    // Say nothing and ask nothing: open the mic and let them speak the doubt.
    // Whatever they say is routed as a doubt (the phase is still "checkpoint"
    // and `pendingQuestionRef` is null, so `ask` takes the doubt branch) —
    // which is exactly what the student has just told us by pressing this.
    setDoubtPending(true);
    gateForcedDoubtRef.current = true;
    // Voice mode: open the mic so they can just say it. Chat mode: `openMicRef`
    // is a no-op by design, and the composer is already there and focused — the
    // flag is what matters either way, because it is what stops the next thing
    // they send being re-classified.
    openMicRef.current();
  }, []);

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
    discardRun();
    boardRef.current?.player.clearAll();
    lastSeen.current.clear();
    setMessages([]);
    setError(null);
    lessonRef.current = { phase: "none", plan: null, step: 0, topic: "", familiarity: null };
    solveRef.current = { question: null, label: null, solved: false };
    setSolveStarted(false);
    setPlanning(false);
    setPlanOutline([]);
    setLessonPhase("none");
    setLessonStarted(false);
    setDoubtPending(false);
    checkpointDoubtRef.current = false;
    gateForcedDoubtRef.current = false;
    setGateOpen(false);
    pendingQuestionRef.current = null;
    recordRef.current = { asked: 0, correct: 0, partial: 0, wrong: 0, doubts: 0, sinceAsked: 0, recent: [], lastDifficulty: null };
    lastTeachRef.current = null;
  };

  /** Choose (or change) the pipeline. Changing it mid-session starts clean: the
   *  two tracks keep different state, and carrying a half-taught lesson into the
   *  solve track (or vice versa) has no sensible meaning. */
  const pickTrack = useCallback(
    (next: TutorTrack) => {
      if (next === trackRef.current) return;
      trackRef.current = next;
      newTopic();
      setTrack(next);
      // Picking a mode IS starting the class, so this is also where the voice
      // stage begins — the student said what they wanted by clicking, and the
      // next thing they should meet is Indica asking for the topic, not another
      // screen asking them to choose again.
      setVoiceMode(true);
      setChatPanelOpen(false);
    },
    // newTopic is a plain closure recreated each render by design; it only touches
    // refs and setters, so capturing the latest one here is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // --- saving the notes (the board's double-click menu) --------------------
  const boardMenu = useBoardMenu();
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);
  // How many pages the PDF would hold. Read when the menu opens rather than
  // tracked continuously: the page count only matters while the menu is up.
  const pdfPages = boardMenu.open && board ? pdfPageList(board.player).length : 0;

  /**
   * Save the page the student is LOOKING at (not the one Indica is writing on —
   * they may have flipped back) as a PNG or an SVG.
   *
   * Excalidraw's own export dialog is switched off in Whiteboard, so these call
   * its export helpers directly. Imported here, at the point of use: both pull
   * in a chunk of the Excalidraw bundle, and neither is needed until a student
   * actually asks for a file.
   */
  const saveBoardImage = useCallback(
    async (kind: "png" | "svg") => {
      const b = boardRef.current;
      if (!b) return;
      boardMenu.close();
      const { viewIndex, activeIndex } = b.player.getPageState();
      const index = viewIndex >= 0 ? viewIndex : activeIndex;
      const elements = index >= 0 ? b.player.pageElements(index) : [];
      if (!elements.length) {
        setError("That page is empty — nothing to save yet.");
        return;
      }
      // Name it by the page number the student can see on the rail, not by the
      // internal allocation index — `pdfPageList` already works that out, and
      // using it here keeps the PNG's name and the PDF's page agreeing.
      const label = pdfPageList(b.player).find((p) => p.index === index)?.label ?? String(index + 1);
      const topicStem =
        (lessonRef.current.topic || "indica-notes")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 50) || "indica-notes";
      const stem = `${topicStem}-page-${label}`;
      try {
        const mod = await import("@excalidraw/excalidraw");
        const appState = { exportBackground: true, viewBackgroundColor: "#ffffff" };
        let blob: Blob;
        if (kind === "png") {
          blob = await mod.exportToBlob({ elements, files: null, appState, exportPadding: 24, mimeType: "image/png" });
        } else {
          const svg = await mod.exportToSvg({ elements, files: null, appState, exportPadding: 24 });
          blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
        }
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = `${stem}.${kind}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(href), 10_000);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save that page.");
      }
    },
    [boardMenu],
  );

  /** Save every page of the session as one landscape PDF. */
  const saveBoardPdf = useCallback(async () => {
    const b = boardRef.current;
    if (!b) return;
    boardMenu.close();
    setPdfBusy("Preparing your PDF…");
    try {
      const mod = await import("@excalidraw/excalidraw");
      const res = await downloadBoardPdf({
        player: b.player,
        exportToCanvas: mod.exportToCanvas as Parameters<typeof downloadBoardPdf>[0]["exportToCanvas"],
        getCommonBounds: mod.getCommonBounds as Parameters<typeof downloadBoardPdf>[0]["getCommonBounds"],
        topic: lessonRef.current.topic || solveRef.current.question,
        onProgress: (done, total) => setPdfBusy(`Preparing page ${Math.min(done + 1, total)} of ${total}…`),
      });
      if ("error" in res) setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the PDF.");
    } finally {
      setPdfBusy(null);
    }
  }, [boardMenu]);

  const busy = status === "thinking" || status === "teaching" || status === "asking";
  // The chat panel is no longer a mode of its own. A session is spoken: the start
  // screen hands straight to the voice stage, and the only way the sidebar comes
  // back is the keyboard affordance (`chatPanelOpen`), which exists because a
  // refused mic or a browser without speech recognition must not be a dead end.
  const showChat = chatPanelOpen;
  // The composer invites the right kind of input for the current lesson stage.
  const composerPlaceholder =
    track === "solve"
      ? solveStarted
        ? "Ask about a step, or name the next question…"
        : "Which question? e.g. “exercise 5.2 question 3”"
      : lessonPhase === "awaitFamiliarity"
        ? "Answer: have you learned this before, or is it new?"
        : lessonPhase === "checkpoint"
          ? "Answer here, or use the buttons above"
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
  // The student pressed Doubt: keep the button hidden until the loop is at rest
  // again. A barge-in that caught nothing speaks a re-prompt at phase
  // "greeting" — with lessonPhase still "teaching" — and only then settles, so
  // without this the button would flash back mid-re-prompt.
  const doubtHold =
    doubtPending && !(voice.phase === "awaiting" || voice.phase === "paused" || voice.phase === "off");
  // The Doubt button is offered while Guru is working (speaking/teaching/thinking)
  // and not already listening — those are the moments a student wants to break in.
  // Gated on the lesson actually being underway: before that there is no lesson
  // to interrupt, and "doubt" has nothing to attach itself to.
  const canRaiseDoubt =
    lessonStarted &&
    // Already answering a doubt (or about to be): the lesson is paused on it, so
    // there is nothing to interrupt and a second "Doubt" button just competes
    // with the answer.
    !doubtHold &&
    lessonPhase !== "doubt" &&
    // At a checkpoint the student has just been ASKED to speak and the mic is
    // already open, so there is nothing to break into — a Doubt button here
    // would only compete with the question it was offered alongside.
    lessonPhase !== "checkpoint" &&
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
          {/* Track toggle: switching restarts, since a lesson and a solved
              question share no state. Hidden until a track is chosen. */}
          {track !== null && (
            <div className="flex overflow-hidden rounded-lg border border-amber-200/70 text-[12px]">
              {(["learn", "solve"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => pickTrack(t)}
                  aria-pressed={track === t}
                  title={t === "learn" ? "Understand a topic, step by step" : "Solve a question, with full working"}
                  className={
                    "px-2.5 py-1 font-medium transition " +
                    (track === t
                      ? "bg-amber-500 text-white"
                      : "bg-white text-neutral-600 hover:bg-amber-50")
                  }
                >
                  {t === "learn" ? "Learn" : "Solve"}
                </button>
              ))}
            </div>
          )}
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
        {/* The same gate, above the composer, for the chat panel. The bug this
            fixes was not specific to voice — a TYPED "no, we can move forward"
            was misread exactly as a spoken one was, because both went through
            the same sentence test. */}
        {gateOpen && (
          <div className="mx-3 mb-2 flex items-center gap-2">
            <button
              type="button"
              onClick={gateNoDoubt}
              className="flex-1 rounded-xl bg-linear-to-b from-emerald-400 to-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm ring-1 ring-inset ring-white/30 transition hover:brightness-105 active:scale-95"
            >
              All clear — continue
            </button>
            <button
              type="button"
              onClick={gateHaveDoubt}
              className="flex-1 rounded-xl bg-linear-to-b from-[#fb923c] to-[#e03e22] px-3 py-2 text-xs font-semibold text-white shadow-sm ring-1 ring-inset ring-white/30 transition hover:brightness-105 active:scale-95"
            >
              I have a doubt
            </button>
          </div>
        )}
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
          <Whiteboard onReady={onReady} planning={planning} />
        </div>
        {busy && !voiceMode && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-neutral-900/85 px-3 py-1 text-xs font-medium text-white shadow">
            {STATUS_LABEL[status]}
            {INTERRUPTIBLE[status] && <span className="opacity-60"> · Esc to interrupt</span>}
          </div>
        )}
        {/* The lesson is being designed — the board is still blank, so the wait
            owns the middle of it in both modes. */}
        {/* The session's setup and its first choice, on one screen: class,
            subject, language, then the mode. Picking a mode starts the voice
            stage, so this is the last thing the student clicks before talking.
            The solve pipeline can only skip the familiarity question because
            the mode was answered up front, here. */}
        {track === null && (
          <StartScreen
            grade={grade}
            subject={subject}
            language={language}
            ready={!!board && !!config}
            onGrade={(g) => {
              setGrade(g);
              writeLocal("guru.grade", String(g));
              // Changing class can invalidate the subject (Class 1 has no
              // Science), so drop one that is no longer offered.
              if (subject != null && !subjectsForGrade(g).includes(subject)) {
                setSubject(null);
                writeLocal("guru.subject", "");
              }
            }}
            onSubject={(sub) => {
              setSubject(sub);
              writeLocal("guru.subject", sub);
            }}
            onLanguage={(code) => {
              setLanguage(code);
              writeLocal("guru.language", code);
            }}
            onStart={pickTrack}
          />
        )}
        {planning && <PlanningCard steps={planOutline} />}
        {/* Page navigation, and the way back to the page Indica is writing on.
            Carries the name of Excalidraw's own "Scroll back to content"
            (hidden in globals.css), which knows nothing about pages. */}
        {board && <BoardPager player={board.player} />}
        {/* Double-click (or two-finger tap) the board: save this page, or the
            whole session as a landscape PDF. */}
        <BoardMenu
          open={boardMenu.open}
          at={boardMenu.at}
          onClose={boardMenu.close}
          pageCount={pdfPages}
          busy={pdfBusy}
          onSavePng={() => void saveBoardImage("png")}
          onSaveSvg={() => void saveBoardImage("svg")}
          onSavePdf={() => void saveBoardPdf()}
        />
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
                  // Don't grab the mic on the way back — wait for Enter.
                  if (voicePhaseRef.current === "paused") voice.standBy();
                }
              }}
              title={chatPanelOpen ? "Back to voice" : "Type instead"}
              aria-label={chatPanelOpen ? "Back to voice" : "Type instead"}
              className="absolute left-3 top-3 z-20 grid h-10 w-10 place-items-center rounded-full bg-white/90 text-neutral-700 shadow ring-1 ring-black/5 backdrop-blur transition hover:bg-white"
            >
              {/* A keyboard, not a hamburger: this is no longer a way to a
                  second mode, it is the way to type when the mic will not do —
                  denied permission, a browser with no speech recognition, or a
                  word Indica keeps mishearing. */}
              {chatPanelOpen ? <HamburgerIcon /> : <KeyboardIcon />}
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

                {/* The checkpoint gate: two buttons for a two-way question.
                    Offered only for the plain "any doubt?" — a real recall
                    question is answered in the student's own words, where a
                    Yes/No pair would mean nothing.
                    The mic stays SHUT while these are up. Opening it alongside
                    them asked the student to speak and showed them what to
                    press at the same time, and then had to guess which they
                    meant; the buttons exist so that nothing is guessed.
                    They sit where the caption strip normally is — centred, low
                    on the stage — because that is where the student is already
                    looking when Indica stops talking. */}
                {gateOpen && (
                  <div className="absolute inset-x-4 bottom-24 z-30 flex flex-wrap items-center justify-center gap-2.5 md:bottom-16">
                    <button
                      type="button"
                      onClick={gateNoDoubt}
                      title="No doubt — carry on with the lesson"
                      aria-label="No doubt, carry on"
                      className="relative block rounded-full bg-linear-to-b from-emerald-400 to-emerald-600 px-5 py-2.5 text-sm font-semibold tracking-wide text-white shadow-lg shadow-emerald-900/30 ring-1 ring-inset ring-white/30 transition duration-150 hover:-translate-y-px hover:shadow-xl hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 active:translate-y-0 active:scale-95"
                    >
                      All clear — continue
                    </button>
                    <button
                      type="button"
                      onClick={gateHaveDoubt}
                      title="I have a doubt — ask it now"
                      aria-label="I have a doubt"
                      className="relative block rounded-full bg-linear-to-b from-[#fb923c] to-[#e03e22] px-5 py-2.5 text-sm font-semibold tracking-wide text-white shadow-lg shadow-orange-900/30 ring-1 ring-inset ring-white/30 transition duration-150 hover:-translate-y-px hover:shadow-xl hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 active:translate-y-0 active:scale-95"
                    >
                      I have a doubt
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

                {/* `!gateOpen`: the gate's buttons stand where this strip does,
                    and the strip's only message at that moment would be the
                    "press Enter, then speak" hint — advice for a mic that is
                    deliberately shut. */}
                {!showSpeechBox && !gateOpen && (voice.voiceCaption || liveCaption || awaitingAnswer || stripStatus) && (
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

      {/* Doubt mode: the answer goes on its own new page, and the whole viewport
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

/**
 * Posts one turn to /api/tutor and dispatches its NDJSON events. The single
 * place that knows the wire format, shared by the one-shot turns and by the
 * staged lesson pipeline.
 */
async function postTutorTurn(
  body: Record<string, unknown>,
  signal: AbortSignal,
  onEvent: (ev: TutorEvent) => void,
) {
  const res = await fetch("/api/tutor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  await readNdjson(res.body, signal, onEvent);
}

/**
 * The lookahead gate. Counts steps that have been asked for but are not yet
 * being spoken, and holds the producer back while that count is at the limit —
 * so the pipeline stays exactly one step ahead of the voice instead of racing
 * off and generating a whole lesson the next doubt may invalidate.
 */
class StepGate {
  private held = 0;
  private waiters: Array<() => void> = [];

  acquire() {
    this.held++;
  }

  release() {
    if (this.held > 0) this.held--;
    for (const w of this.waiters.splice(0)) w();
  }

  async waitBelow(limit: number, signal: AbortSignal) {
    while (this.held >= limit && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };
        this.waiters.push(done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}

/**
 * The numbered heading that opens a step's page: "3. Factorisation method",
 * then a thick rule across the page separating it from the working below.
 *
 * Drawn by the client, not the model, and that is deliberate on three counts:
 *  - it appears EXACTLY ONCE per subtopic. A step that spills onto a second or
 *    third page carries no heading there, so a long subtopic reads as one
 *    stretch under one title. Asking the model for it per beat could not
 *    guarantee that, because the model does not know where the page broke.
 *  - the rule is genuinely thick. The model's `line` op renders at a fixed
 *    strokeWidth of 2 (see lib/canvas/ops.ts); this stacks three hairlines a
 *    pixel apart to read as one heavy rule, which is the only way to get real
 *    weight without plumbing a stroke width through the whole op schema.
 *  - the number matches the roadmap page. Both come from the same
 *    `plan.steps[i].title`, so "3. Factorisation method" in the contents is
 *    "3. Factorisation method" at the top of the page it points at.
 *
 * The step's own beats are written as if the page were blank, starting around
 * CONTENT_TOP — they are not told about this heading, and they do not need to
 * be: `BoardPlayer.drawStepHeading` reserves the band this occupies, so the
 * step's content is laid out below the rule. That reservation is load-bearing,
 * not a nicety — collision avoidance alone does NOT cover it, because it fires
 * only on a true overprint and prefers to dodge upward, so a first line that
 * merely grazes the title stays exactly where the model put it.
 */
function stepHeadingOps(step: number, title: string): DrawOp[] {
  const ruleY = CONTENT_TOP + STEP_RULE_OFFSET; // clears the 36px lg heading plus a little air
  return [
    {
      op: "text",
      id: `step_head_${step}`,
      layout: "fixed",
      x: CONTENT_LEFT,
      y: CONTENT_TOP,
      text: `${step + 1}. ${stripStepNumber(title)}`,
      size: "lg",
      color: "purple",
    },
    // Three hairlines a pixel apart: one `line` op is 2px, which reads as a
    // body underline rather than a heading rule.
    ...[0, 1.5, 3].map((dy, i) => ({
      op: "line" as const,
      id: `step_rule_${step}_${i}`,
      layout: "fixed" as const,
      x: CONTENT_LEFT,
      y: ruleY + dy,
      x2: CONTENT_RIGHT,
      y2: ruleY + dy,
      color: "purple" as const,
    })),
  ];
}

/**
 * The spoken roadmap, as beats, straight from the plan — no model call, so it
 * costs nothing and starts instantly. Indica says each step's one-line preview
 * (the planner wrote those in the student's language) while writing the step
 * titles up as a contents page the student can flip back to.
 */
function agendaBeats(plan: LessonPlan, lang: string): Beat[] {
  // Every step gets a line: the contents page is the map of the whole lesson,
  // and a plan truncated at 8 would hide the last third of a 12-step one.
  const steps = plan.steps;
  // Tighten the line pitch to fit however many there are. A 12-step plan at the
  // old fixed 56px ran 56px past CONTENT_BOTTOM and off the page; this keeps the
  // list inside the page and leaves the common 8-step case looking as it did.
  //
  // The LAST line's top must leave room for its own height plus the player's
  // FIT_MARGIN, or the fit test spills that one line onto a page of its own —
  // which is what a 12-step trigonometry plan did (step 12 alone on page 2).
  // Dividing the whole height by n placed the last top at ~620 and its box at
  // ~650, over the 636 the fit test allows.
  const listTop = CONTENT_TOP + 100;
  const LINE_BOX = 34; // an `sm` line with a superscript (sin²θ) in it
  const lastTop = CONTENT_BOTTOM - FIT_MARGIN - LINE_BOX;
  const pitch = steps.length > 1 ? Math.min(56, (lastTop - listTop) / (steps.length - 1)) : 56;
  const beats: Beat[] = [
    {
      say: plan.intro?.trim() || roadmapIntro(lang),
      lang,
      draw: [
        {
          op: "text",
          id: "agenda_title",
          layout: "fixed",
          x: CONTENT_LEFT,
          y: CONTENT_TOP,
          text: plan.topic?.trim() || "Our plan",
          size: "lg",
          color: "purple",
        },
      ],
    },
  ];
  steps.forEach((s, i) => {
    beats.push({
      say: s.roadmap?.trim() || `${i + 1}. ${stripStepNumber(s.title)}`,
      lang,
      draw: [
        {
          op: "text",
          id: `agenda_${i + 1}`,
          layout: "fixed",
          x: CONTENT_LEFT + 30,
          y: listTop + i * pitch,
          text: `${i + 1}. ${stripStepNumber(s.title)}`,
          size: pitch < 44 ? "sm" : "md",
        },
      ],
    });
  });
  return beats;
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
