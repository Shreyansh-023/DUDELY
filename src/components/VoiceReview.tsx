"use client";

import { useEffect, useRef } from "react";

type Props = {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onRetry: () => void;
  /** Still listening/transcribing: the box fills itself and can't be edited yet. */
  live: boolean;
};

/**
 * The student's own words on the voice stage — one element for the whole
 * utterance, from the first syllable to the moment it is sent.
 *
 * While the mic is open it fills line by line with the recogniser's partials
 * and is read-only (the tail is still being revised; a caret in the middle of
 * that would fight the student). When the utterance is closed it becomes an
 * ordinary editable box, takes focus, and its retry/send buttons light up.
 * Keeping it one element means no pop-in and no layout jump at the handover.
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
export default function VoiceReview({ value, onChange, onSend, onRetry, live }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Take focus the moment editing opens (not before — focusing a read-only box
  // mid-sentence would pop the mobile keyboard over the board). Caret at the
  // end, so Enter sends and typing corrects without clicking in first.
  useEffect(() => {
    const el = taRef.current;
    if (live || !el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [live]);

  const canSend = !live && value.trim().length > 0;
  // Shared by the textarea and its invisible sizing twin — any divergence here
  // shows up as the text drifting out of the box.
  //
  // `wrap-anywhere` (overflow-wrap: anywhere), not `wrap-break-word`: only the
  // former shrinks the min-content size. With break-word a long unbroken run
  // ("mmmm…", a URL, a pasted token) still reports its full unwrapped width as
  // the grid track's minimum, so the track overflows the card and the text
  // sails out past the right edge while the card itself stays clamped.
  const TYPE = "px-4 py-2.5 text-center text-[15px] leading-6 wrap-anywhere md:text-base md:leading-7";

  return (
    <div
      className={
        "pointer-events-auto flex w-fit max-w-[min(94vw,48rem)] items-end gap-1.5 rounded-[1.75rem] border bg-[#fffdf7]/90 p-1.5 shadow-lg shadow-amber-900/10 backdrop-blur-md transition " +
        (live
          ? "border-rose-200/70"
          : "border-amber-200/70 focus-within:border-amber-400 focus-within:ring-2 focus-within:ring-amber-200/70")
      }
    >
      <div className="relative grid min-w-48 flex-1">
        <textarea
          ref={taRef}
          value={value}
          readOnly={live}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          rows={1}
          aria-label="What you said — edit before sending"
          className={"col-start-1 row-start-1 max-h-48 resize-none overflow-y-auto bg-transparent text-neutral-800 outline-none " + TYPE}
        />
        {/* Invisible twin: its wrapped height and natural width size the grid
            cell, and the textarea above stretches to fill it. The trailing
            space keeps the box from collapsing on a newline.
            It carries the same max-height as the textarea, and must: the row is
            sized from this span's contribution, so capping only the textarea
            lets the row keep growing past it — the card stretches on while the
            textarea stops and scrolls, leaving a hole above the buttons. */}
        <span aria-hidden className={"col-start-1 row-start-1 invisible max-h-48 overflow-hidden whitespace-pre-wrap " + TYPE}>
          {value + " "}
        </span>
        {/* Mic open, nothing heard yet — so the student can tell it's live. */}
        {live && !value && (
          <span
            className={
              "pointer-events-none col-start-1 row-start-1 flex items-center justify-center gap-1.5 text-rose-500 " + TYPE
            }
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-500" />
            </span>
            Listening…
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={onRetry}
        disabled={live}
        aria-label="Say it again"
        title="Say it again"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-amber-100/70 hover:text-amber-700 active:scale-95 disabled:opacity-30 disabled:hover:bg-transparent"
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
