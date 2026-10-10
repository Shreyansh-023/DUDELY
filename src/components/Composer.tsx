"use client";

import { useState } from "react";

type Props = {
  status: "idle" | "listening" | "transcribing" | "thinking" | "teaching";
  interim: string;
  disabled: boolean;
  onSend: (text: string) => void;
  onToggleMic: () => void;
  onStop: () => void;
};

export default function Composer({ status, interim, disabled, onSend, onToggleMic, onStop }: Props) {
  const [text, setText] = useState("");
  const listening = status === "listening";
  const busy = status === "thinking" || status === "teaching";

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="border-t border-neutral-200 bg-white/80 p-3 backdrop-blur">
      {listening && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
          </span>
          <span className="truncate">{interim || "Listening… tap the mic again when done (or release Space)"}</span>
        </div>
      )}
      {status === "transcribing" && (
        <div className="mb-2 rounded-lg bg-neutral-100 px-3 py-1.5 text-xs text-neutral-600">Transcribing…</div>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={onToggleMic}
          disabled={disabled || status === "transcribing"}
          aria-label={listening ? "Stop listening" : "Start listening"}
          title={listening ? "Stop" : "Speak (or hold Space)"}
          className={
            "grid h-11 w-11 shrink-0 place-items-center rounded-full text-white shadow-md transition hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100 " +
            (listening
              ? "bg-red-500 shadow-red-500/30 hover:bg-red-600"
              : "bg-linear-to-b from-amber-400 to-amber-500 shadow-amber-500/30 hover:from-amber-500 hover:to-amber-600")
          }
        >
          {listening ? <StopIcon /> : <MicIcon />}
        </button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Ask in Hindi, English, Tamil…"
          disabled={disabled}
          className="min-h-11 max-h-32 flex-1 resize-none rounded-xl border border-neutral-200 bg-neutral-50 px-3.5 py-2.5 text-sm shadow-sm outline-none transition focus:border-amber-400 focus:bg-white focus:ring-2 focus:ring-amber-200 disabled:opacity-50"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="h-11 shrink-0 rounded-xl bg-neutral-800 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-neutral-900 active:scale-95"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !text.trim()}
            className="h-11 shrink-0 rounded-xl bg-amber-500 px-4 text-sm font-semibold text-white shadow-sm shadow-amber-500/30 transition hover:bg-amber-600 active:scale-95 disabled:opacity-40 disabled:hover:bg-amber-500"
          >
            Ask
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-neutral-400">Hold Space to talk · Esc to interrupt Guru</p>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
