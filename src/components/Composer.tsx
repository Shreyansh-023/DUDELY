"use client";

import { useEffect, useRef } from "react";

type Props = {
  status: "idle" | "listening" | "transcribing" | "thinking" | "teaching";
  /** What's in the box, owned by Tutor so dictation can write into it. */
  draft: string;
  onDraftChange: (text: string) => void;
  /** Live speech not yet committed — rendered after the draft, in grey. */
  interim: string;
  disabled: boolean;
  voiceMode: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  onToggleMic: () => void;
  onStop: () => void;
  onEnterVoice: () => void;
};

/** Join a typed draft and dictated speech without doubling or dropping the space. */
export function joinDictation(draft: string, speech: string): string {
  if (!draft.trim()) return speech;
  if (!speech) return draft;
  return /\s$/.test(draft) ? draft + speech : `${draft} ${speech}`;
}

export default function Composer({
  status,
  draft,
  onDraftChange,
  interim,
  disabled,
  voiceMode,
  placeholder,
  onSend,
  onToggleMic,
  onStop,
  onEnterVoice,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const listening = status === "listening";
  const busy = status === "thinking" || status === "teaching";
  const dictating = interim.length > 0;
  // What the student actually sees: typed text with the live speech running on
  // the end of it, the way ChatGPT's dictation fills its composer as you talk.
  const shown = dictating ? joinDictation(draft, interim) : draft;
  const hasText = shown.trim().length > 0;

  // Auto-grow the field like ChatGPT: one line at rest, up to a cap, then scroll.
  // Runs on every value change, so speech arriving from the mic grows the box too.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    // Keep the newest words in view while dictation runs past the visible area.
    if (dictating) el.scrollTop = el.scrollHeight;
  }, [shown, dictating]);

  const submit = () => {
    const t = shown.trim();
    if (!t) return;
    onSend(t);
    onDraftChange("");
  };

  return (
    <div className="p-3">
      {status === "transcribing" && (
        <div className="mb-2 rounded-lg bg-neutral-100 px-3 py-1.5 text-xs text-neutral-600">Transcribing…</div>
      )}

      {/* One rounded box, ChatGPT-style: the field and every control live inside it. */}
      <div
        className={
          "flex items-end gap-1 rounded-3xl border bg-white px-2 py-1.5 shadow-md shadow-amber-900/5 transition focus-within:ring-2 " +
          (listening
            ? "border-rose-300 ring-2 ring-rose-100 focus-within:border-rose-400 focus-within:ring-rose-200"
            : "border-amber-100 focus-within:border-amber-400 focus-within:ring-amber-200")
        }
      >
        {/* While the mic is open the field is a live transcript, so it's read-only:
            the recogniser keeps revising its tail and a caret in the middle of
            that would fight the student. It becomes editable the moment the
            words are committed. */}
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={taRef}
            value={shown}
            readOnly={dictating}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!dictating) submit(); // mid-dictation Enter would send half a sentence
              }
            }}
            rows={1}
            placeholder={listening ? "" : placeholder}
            disabled={disabled}
            className="min-h-9 max-h-40 w-full resize-none self-center bg-transparent px-2.5 py-2 text-sm leading-6 outline-none placeholder:text-neutral-400 disabled:opacity-50"
          />
          {/* Nothing said yet: a pulsing hint in place of the placeholder, so the
              student can tell the mic is live and simply hasn't heard them. */}
          {listening && !shown && (
            <span className="pointer-events-none absolute left-2.5 top-2 flex items-center gap-1.5 py-0 text-sm leading-6 text-rose-500">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-500" />
              </span>
              Listening…
            </span>
          )}
        </div>

        {/* Mic — a quiet in-box control (dictation / pause-resume in voice mode). */}
        <button
          type="button"
          onClick={onToggleMic}
          disabled={disabled || status === "transcribing"}
          aria-label={listening ? "Stop listening" : "Start listening"}
          title={listening ? "Stop" : "Speak (or hold Space to send on release)"}
          className={
            "grid h-9 w-9 shrink-0 place-items-center rounded-full transition active:scale-95 disabled:opacity-40 " +
            (listening
              ? "bg-red-500 text-white hover:bg-red-600"
              : "text-neutral-500 hover:bg-neutral-100 hover:text-amber-600")
          }
        >
          {listening ? <StopIcon /> : <MicIcon />}
        </button>

        {/* Primary action, same slot throughout:
            busy → Stop · text present → send (up-arrow) · empty → voice mode (waveform). */}
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            title="Stop"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-neutral-800 text-white transition hover:bg-neutral-900 active:scale-95"
          >
            <SquareIcon />
          </button>
        ) : hasText ? (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || dictating}
            aria-label="Send"
            title={dictating ? "Still listening…" : "Send"}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-500 text-white shadow-sm shadow-amber-500/30 transition hover:scale-105 hover:bg-amber-600 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
          >
            <ArrowUpIcon />
          </button>
        ) : !voiceMode ? (
          <button
            type="button"
            onClick={onEnterVoice}
            disabled={disabled}
            aria-label="Voice mode"
            title="Voice mode — full board with a talking Indica"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-linear-to-b from-amber-500 to-amber-600 text-white shadow-sm shadow-amber-500/30 transition hover:scale-105 hover:from-amber-600 hover:to-amber-700 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
          >
            <VoiceIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function SquareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  );
}

function VoiceIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="2.5" y="9" width="2" height="6" rx="1" />
      <rect x="6.5" y="6.5" width="2" height="11" rx="1" />
      <rect x="10.5" y="3.5" width="2" height="17" rx="1" />
      <rect x="14.5" y="6.5" width="2" height="11" rx="1" />
      <rect x="18.5" y="9" width="2" height="6" rx="1" />
    </svg>
  );
}
