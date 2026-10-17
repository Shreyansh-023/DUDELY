"use client";

import { useEffect, useRef } from "react";

type Props = {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onRetry: () => void;
};

/**
 * What the recogniser heard, handed to the student to check. It takes over the
 * same spot VoiceCapture's waveform had, in the same shell, so the handover
 * reads as the box settling rather than one card swapping for another.
 *
 * Nothing is sent until the student presses send: recognition is never perfect,
 * least of all on code-mixed Hinglish, and a misheard word would otherwise
 * silently become the question Indica answers.
 *
 * Sizing: the box grows with the text, sideways first and then down, which is
 * what a one-line answer ("haan, samajh gaya") and a three-line question each
 * want. That's the grid-overlay trick — an invisible span carrying the same
 * text defines the intrinsic size and the textarea is stretched over it —
 * because a textarea has no intrinsic width or height of its own. The span and
 * the textarea must keep identical type, alignment and padding or the two will
 * drift apart.
 */
export default function VoiceReview({ value, onChange, onSend, onRetry }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Take focus as the box opens, caret at the end, so Enter sends and typing
  // corrects without having to click in first.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const canSend = value.trim().length > 0;
  // Shared by the textarea and its invisible sizing twin — any divergence here
  // shows up as the text drifting out of the box.
  //
  // `wrap-anywhere` (overflow-wrap: anywhere), not `wrap-break-word`: only the
  // former shrinks the min-content size. With break-word a long unbroken run
  // ("mmmm…", a URL, a pasted token) still reports its full unwrapped width as
  // the grid track's minimum, so the track overflows the card and the text
  // sails out past the right edge while the card itself stays clamped.
  // py is picked so the text's vertical centre lands exactly on the retry/send
  // buttons' centre (h-10 = 40px, so 20px from the top): 8px + half of the
  // 24px line box = 20 at rest, and 6px + half of the 28px md line box = 20.
  const TYPE = "px-4 py-2 md:py-1.5 text-center text-[15px] leading-6 wrap-anywhere md:text-base md:leading-7";

  return (
    <div
      className="pointer-events-auto flex w-fit max-w-[min(94vw,48rem)] items-end gap-1.5 rounded-[1.75rem] border border-amber-200/70 bg-[#fffdf7]/90 p-1.5 shadow-lg shadow-amber-900/10 backdrop-blur-md transition focus-within:border-amber-400 focus-within:ring-2 focus-within:ring-amber-200/70"
    >
      <div className="relative grid min-w-48 flex-1">
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          rows={1}
          aria-label="What you said — edit before sending"
          // `block`: a textarea is inline-block by default, so it sits on its
          // wrapper's text baseline and leaves descender space underneath — the
          // grid cell reports a height taller than one real text line, and with
          // the outer row `items-end` that drops the retry/send buttons below
          // middle while the text stays above it. Mirrored on the span below,
          // since the two must stay identical or they drift apart.
          className={"col-start-1 row-start-1 block max-h-48 resize-none overflow-y-auto bg-transparent text-neutral-800 outline-none " + TYPE}
        />
        {/* Invisible twin: its wrapped height and natural width size the grid
            cell, and the textarea above stretches to fill it. The trailing
            space keeps the box from collapsing on a newline.
            It carries the same max-height as the textarea, and must: the row is
            sized from this span's contribution, so capping only the textarea
            lets the row keep growing past it — the card stretches on while the
            textarea stops and scrolls, leaving a hole above the buttons. */}
        <span aria-hidden className={"col-start-1 row-start-1 block invisible max-h-48 overflow-hidden whitespace-pre-wrap " + TYPE}>
          {value + " "}
        </span>
      </div>

      <button
        type="button"
        onClick={onRetry}
        aria-label="Say it again"
        title="Say it again"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-amber-100/70 hover:text-amber-700 active:scale-95"
      >
        <RetryIcon />
      </button>
      <button
        type="button"
        onClick={onSend}
        disabled={!canSend}
        aria-label="Send"
        title="Send (Enter)"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-linear-to-b from-amber-500 to-amber-600 text-white shadow-sm shadow-amber-500/30 transition hover:scale-105 hover:from-amber-600 hover:to-amber-700 active:scale-95 disabled:opacity-30 disabled:hover:scale-100"
      >
        <ArrowUpIcon />
      </button>
    </div>
  );
}

function RetryIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 1 2.64 6.36" />
      <path d="M3 20v-5h5" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="19" x2="12" y2="5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  );
}
