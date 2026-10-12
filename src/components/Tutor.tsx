"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { isGrade, isSubject, type Grade, type SubjectId } from "@/lib/curriculum";
import { askPlaceholder, DEFAULT_LANGUAGE } from "@/lib/languages";
import type { Beat, HistoryMessage, TutorEvent } from "@/lib/schema";
import { AsyncQueue, uid } from "@/lib/utils";
import { Recorder, browserSttAvailable, recognizeBrowser, transcribeOnServer, type SttMode } from "@/lib/voice/stt";
import { fetchSpeech, playBlob, speakBrowser, type TtsMode } from "@/lib/voice/tts";
import ClassSubjectPicker from "./ClassSubjectPicker";
import Composer from "./Composer";
import { LogoTile, Wordmark } from "./Logo";
import LanguageMenu from "./LanguageMenu";
import Transcript from "./Transcript";
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

// A statement turn ends "ready to continue"; a question turn ends on "?". We use
// the last character of the spoken reply to tell the two apart.
const isQuestionEnding = (t: string) => /[?？]\s*$/.test(t.trim());
// Hidden user turn that asks the model to teach the next small step. Phrased as
// plain language so the model (which mirrors the student's language) just carries on.
const CONTINUE_NUDGE = "Continue to the next step.";
type Config = { llm: string | null; stt: SttMode; tts: TtsMode };
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

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
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
  const [voiceMode, setVoiceMode] = useState(false); // avatar-only stage, chat hidden
  const [chatPanelOpen, setChatPanelOpen] = useState(false); // in voice mode, the hamburger brings chat back

  // Latest values for use inside async callbacks (kept in sync in an effect, never during render).
  const boardRef = useRef<Board | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const configRef = useRef<Config | null>(null);
  const languageRef = useRef(language);
  const gradeRef = useRef(grade);
  const subjectRef = useRef(subject);
  const statusRef = useRef<Status>("idle");
  const voiceModeRef = useRef(false);
  useEffect(() => {
    boardRef.current = board;
    messagesRef.current = messages;
    configRef.current = config;
    languageRef.current = language;
    gradeRef.current = grade;
    subjectRef.current = subject;
    statusRef.current = status;
    voiceModeRef.current = voiceMode;
  }, [board, messages, config, language, grade, subject, status, voiceMode]);

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
  const lastSeen = useRef(new Map<string, number>());
  const recorderRef = useRef<Recorder | null>(null);
  const browserRecRef = useRef<{ stop: () => void } | null>(null);

  // Load server capabilities, then restore the student's saved settings.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json() as Promise<Config>)
      .catch((): Config => ({ llm: null, stt: "browser", tts: "browser" }))
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
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
    // Settle pending replies; drop ones that never got any text so no empty bubble lingers.
    setMessages((m) => m.flatMap((x) => (x.pending ? (x.text ? [{ ...x, pending: false }] : []) : [x])));
    // An interrupted turn must not auto-continue: the student stopped it to speak.
    lastTurnRef.current = { aborted: true, hadText: false, endedWithQuestion: false };
    setStatus("idle");
  }, []);

  const speakBeat = useCallback(async (beat: Beat, audio: Promise<Blob | null> | null, signal: AbortSignal) => {
    if (!beat.say.trim()) return;
    const lang = beat.lang || languageRef.current;
    if (audio) {
      const blob = await audio;
      if (signal.aborted) return;
      if (blob) return playBlob(blob, signal);
    }
    return speakBrowser(beat.say, lang, signal);
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

  const ask = useCallback(
    async (rawText: string, opts?: { hidden?: boolean }) => {
      const text = rawText.trim();
      const b = boardRef.current;
      if (!text || !b) return;
      stopTurn();
      setError(null);
      setInterim("");
      turnTextRef.current = "";

      const ac = new AbortController();
      turnRef.current = ac;
      const turn = ++turnCounter.current;
      const cfg = configRef.current ?? { llm: null, stt: "browser" as const, tts: "browser" as const };
      const lang = languageRef.current;

      // Board context: a text summary of what is on the board and what the
      // student just drew. (No screenshots — text only, by design.)
      const elements = b.api.getSceneElements();
      const studentEls = elements.filter((e) => !b.isTutorElement(e));
      const changed = studentEls.filter((e) => (lastSeen.current.get(e.id) ?? -1) < e.version);
      for (const e of studentEls) lastSeen.current.set(e.id, e.version);
      const canvas = b.summarizeScene(elements, new Set(changed.map((e) => e.id)));

      const userMsg: ChatMessage = { id: uid("u"), role: "user", text, hidden: opts?.hidden };
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
        // Same policy as stopTurn: a reply that produced no text (e.g. the model
        // errored out) disappears instead of leaving an empty bubble.
        setMessages((m) => m.flatMap((x) => (x.id === assistantId ? (x.text ? [{ ...x, pending: false }] : []) : [x])));
        setStatus("idle");
      }
    },
    [playQueue, stopTurn],
  );

  // Voice-loop hooks: after a statement turn, keep teaching instead of waiting.
  const continueLesson = useCallback(() => {
    void ask(CONTINUE_NUDGE, { hidden: true });
  }, [ask]);
  const shouldContinueLesson = useCallback(() => {
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

  // ---- microphone (push-to-talk, normal chat mode) -----------------------
  const startListening = useCallback(async () => {
    if (statusRef.current === "listening") return;
    stopTurn(); // barge-in: interrupt Guru
    setError(null);
    setInterim("");
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
      const rec = recognizeBrowser(languageRef.current, setInterim);
      browserRecRef.current = rec;
      rec.result
        .then((text) => {
          browserRecRef.current = null;
          setInterim("");
          if (text) void ask(text);
          else setStatus("idle");
        })
        .catch((e: Error) => {
          browserRecRef.current = null;
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
    }
  }, [ask, stopTurn]);

  const stopListening = useCallback(async () => {
    if (browserRecRef.current) {
      browserRecRef.current.stop();
      return;
    }
    const r = recorderRef.current;
    if (!r) return;
    recorderRef.current = null;
    setStatus("transcribing");
    const blob = await r.stop();
    if (blob.size < 1500) {
      setStatus("idle");
      return;
    }
    try {
      const text = await transcribeOnServer(blob, languageRef.current);
      if (text.trim()) void ask(text);
      else {
        setStatus("idle");
        setError("Didn't catch that. Try again a little closer to the mic.");
      }
    } catch (e) {
      setStatus("idle");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [ask]);

  const toggleMic = useCallback(() => {
    if (statusRef.current === "listening") void stopListening();
    else void startListening();
  }, [startListening, stopListening]);

  // Space = push-to-talk (normal mode) / resume (voice mode, paused). Esc = interrupt.
  const { pause: voicePause, resume: voiceResume } = voice;
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
      if (e.code === "Space" && !e.repeat && !isTyping(e.target)) {
        e.preventDefault();
        if (voiceModeRef.current) {
          // The loop owns the mic; Space only wakes it from the paused state.
          if (voicePhaseRef.current === "paused") voiceResume();
          return;
        }
        void startListening();
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
  }, [startListening, stopListening, stopTurn, voicePause, voiceResume]);

  // Deep link: /?q=your+question asks it automatically once the board and config are ready.
  const autoAsked = useRef(false);
  useEffect(() => {
    if (!board || !config || autoAsked.current) return;
    const q = new URLSearchParams(window.location.search).get("q");
    if (!q) return;
    autoAsked.current = true;
    void ask(q);
  }, [board, config, ask]);

  const newTopic = () => {
    stopTurn();
    boardRef.current?.player.clearAll();
    lastSeen.current.clear();
    setMessages([]);
    setError(null);
  };

  const busy = status === "thinking" || status === "teaching";
  // In voice mode the chat is hidden until the hamburger reopens it.
  const showChat = !voiceMode || chatPanelOpen;

  // Voice-stage derived state. Caption priority: the student's live words while
  // they speak → what Guru is saying (greeting/re-prompt) → latest reply text.
  let lastAssistant = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].text) {
      lastAssistant = messages[i].text;
      break;
    }
  }
  const guruListening = voice.phase === "listening" || voice.phase === "capturing";
  const guruSpeaking = status === "teaching" || voice.phase === "greeting";
  const studentSpeaking = guruListening && Boolean(interim.trim());
  const caption = studentSpeaking ? interim : (voice.voiceCaption ?? lastAssistant);
  const voiceChip =
    voice.phase === "greeting"
      ? "Indica is speaking…"
      : guruListening
        ? "Listening…"
        : voice.phase === "paused"
          ? "Paused — tap Indica or press Space"
          : status === "thinking"
            ? "Indica is thinking…"
            : status === "teaching"
              ? "Indica is teaching… · Esc to skip"
              : "One moment…";

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
          interim={interim}
          disabled={!board || !config}
          voiceMode={voiceMode}
          placeholder={askPlaceholder(language)}
          onSend={(t) => void ask(t)}
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
        <div className={"absolute inset-0" + (voiceMode ? " md:right-60" : "") + (status === "teaching" ? " guru-teaching" : "")}>
          <Whiteboard onReady={onReady} />
        </div>
        {busy && !voiceMode && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-neutral-900/85 px-3 py-1 text-xs font-medium text-white shadow">
            {STATUS_LABEL[status]} <span className="opacity-60">· Esc to interrupt</span>
          </div>
        )}
        {board && status === "teaching" && (
          <button
            type="button"
            onClick={() => board.player.recenter()}
            title="Jump to where Indica is teaching"
            className={
              "absolute right-3 z-10 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium shadow ring-1 ring-black/5 backdrop-blur transition hover:brightness-105 " +
              (voiceMode ? "top-16 md:top-3 md:right-63 " : "top-3 ") +
              (status === "teaching" ? "animate-pulse bg-amber-500 text-white" : "bg-white/90 text-neutral-700 hover:bg-white")
            }
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="3.5" />
              <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" />
            </svg>
            Jump to Indica
          </button>
        )}

        {voiceMode && (
          <>
            {/* Guru's rail (md+): the board above ends at its left edge, so
                whiteboard writing can never run behind the avatar or caption. */}
            <div
              aria-hidden
              className="absolute inset-y-0 right-0 z-10 hidden w-60 border-l border-neutral-200/60 bg-[#fffdf7] md:block"
            />

            {/* Hamburger — reopens the chat on the left, shrinking the board */}
            <button
              type="button"
              onClick={() => setChatPanelOpen((v) => !v)}
              title={chatPanelOpen ? "Hide chat" : "Show chat"}
              aria-label={chatPanelOpen ? "Hide chat" : "Show chat"}
              className="absolute left-3 top-3 z-20 grid h-10 w-10 place-items-center rounded-full bg-white/90 text-neutral-700 shadow ring-1 ring-black/5 backdrop-blur transition hover:bg-white"
            >
              <HamburgerIcon />
            </button>

            {/* Exit voice mode */}
            <button
              type="button"
              onClick={() => {
                stopTurn();
                setVoiceMode(false);
              }}
              className="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-neutral-900/85 px-3 py-1.5 text-xs font-medium text-white shadow backdrop-blur transition hover:bg-neutral-900"
            >
              <CloseIcon /> Exit voice
            </button>

            {/* Talking Guru (bottom-right, like a presenter cam). Mouth is driven by
                live audio; amber glow while speaking, rose pulse while listening.
                No mic button — the hands-free loop owns the microphone. */}
            <div className="pointer-events-none absolute right-4 top-28 z-20 flex flex-col items-center gap-2 md:right-0 md:top-14 md:w-60 md:px-3">
              <div className="relative">
                {guruListening && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute -inset-1.5 animate-pulse rounded-full border-4 border-rose-400/70"
                  />
                )}
                <div
                  className={
                    "relative h-32 w-32 overflow-hidden rounded-full bg-linear-to-b from-amber-50 to-amber-100 ring-2 transition-shadow duration-300 md:h-36 md:w-36 " +
                    (guruSpeaking
                      ? "ring-amber-400 shadow-[0_0_38px_8px_rgba(245,158,11,0.5)]"
                      : guruListening
                        ? "ring-rose-300 shadow-[0_0_30px_6px_rgba(244,63,94,0.4)]"
                        : "ring-white/70 shadow-2xl")
                  }
                >
                  <Avatar className="h-full w-full" />
                  {voice.phase === "paused" && (
                    <button
                      type="button"
                      onClick={voice.resume}
                      aria-label="Resume listening"
                      title="Resume listening"
                      className="pointer-events-auto absolute inset-0 z-10 grid place-items-center rounded-full bg-neutral-900/45 text-white transition hover:bg-neutral-900/55"
                    >
                      <PlayIcon />
                    </button>
                  )}
                </div>
              </div>
              <span
                aria-live="polite"
                className="rounded-full bg-neutral-900/70 px-2.5 py-0.5 text-[11px] font-medium text-white backdrop-blur"
              >
                {voiceChip}
              </span>
              {caption && (
                <div
                  className={
                    "max-w-[min(70vw,20rem)] overflow-y-auto rounded-2xl bg-neutral-900/80 px-3.5 py-2 text-center text-sm leading-snug shadow-lg backdrop-blur md:max-h-[55dvh] md:max-w-full " +
                    (studentSpeaking ? "italic text-rose-100" : "text-white")
                  }
                >
                  {caption}
                </div>
              )}
            </div>
          </>
        )}
      </section>
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
