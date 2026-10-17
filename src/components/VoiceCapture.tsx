"use client";

import { useEffect, useRef, type RefObject } from "react";

type Props = {
  /** "live" — the mic is open; "transcribing" — the utterance is closed, words pending. */
  state: "live" | "transcribing";
  /** Mic loudness (RMS), read every tick. 0 throughout means no feed — see below. */
  levelRef: RefObject<number>;
  /** Throw the utterance away and hand the floor back. */
  onCancel: () => void;
  /** "I've finished" — close the utterance now instead of waiting out the silence. */
  onStop: () => void;
};

/** Bars in the trace. The strip clips on the left, so this is a history depth. */
const BARS = 56;
/** Tick of the trace. Matches the VAD's own 50ms analysis interval. */
const TICK_MS = 55;
/** RMS that counts as "shouting" — the top of the bar's range. */
const LOUD_RMS = 0.2;

/**
 * The student's voice while they are speaking.
 *
 * It deliberately shows a *waveform* rather than the recogniser's running
 * partials. Partials are revised constantly — words appear, change and vanish
 * mid-sentence — and watching that happen is both distracting and discouraging
 * when it mishears you. The trace says the same thing the partials were really
 * being used to say ("it can hear you") without inviting the student to read
 * along. The words then arrive once, settled, in the review box.
 *
 * Shares its shell with VoiceReview so capture → transcribe → review is one box
 * changing its contents, not three boxes replacing each other.
 */
export default function VoiceCapture({ state, levelRef, onCancel, onStop }: Props) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const live = state === "live";

  useEffect(() => {
    if (!live) return;
    const history = new Array<number>(BARS).fill(0);
    // The browser-STT path recognises off its own mic and never hands us the
    // stream, so no level ever arrives. Rather than show a dead flat line,
    // fall back to a synthetic trace once it's clear nothing is coming.
    let fed = false;
    let t = 0;

    const id = setInterval(() => {
      t += 1;
      const rms = levelRef.current ?? 0;
      if (rms > 0.004) fed = true;
      const amp = fed
        ? Math.min(1, Math.sqrt(rms / LOUD_RMS))
        : // Two detuned sines read as speech rhythm; neither is a round
          // multiple of the other, so the pattern doesn't visibly repeat.
          0.3 + 0.26 * Math.sin(t / 2.7) * Math.sin(t / 6.1) + 0.1 * Math.sin(t / 1.3);

      history.push(Math.max(0, Math.min(1, amp)));
      history.shift();

      for (let i = 0; i < BARS; i++) {
        const el = barsRef.current[i];
        if (!el) continue;
        const a = history[i];
        el.style.height = `${3 + Math.round(a * 23)}px`;
        el.style.opacity = `${0.3 + a * 0.7}`;
      }
    }, TICK_MS);

    return () => clearInterval(id);
  }, [live, levelRef]);

  return (
    <div className="pointer-events-auto flex w-fit max-w-[min(94vw,48rem)] items-center gap-1.5 rounded-[1.75rem] border border-orange-200/70 bg-[#fffdf7]/90 p-1.5 shadow-lg shadow-amber-900/10 backdrop-blur-md">
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel"
        title="Cancel"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-orange-100/70 hover:text-[#e03e22] active:scale-95"
      >
        <CloseIcon />
      </button>

      {/* The trace. Right-aligned and clipped, so the newest sample is always at
          the right edge and older ones scroll off the left. */}
      <div className="grid h-10 w-[min(62vw,24rem)] place-items-center overflow-hidden px-1">
        {live ? (
          <div aria-hidden className="col-start-1 row-start-1 flex h-7 w-full items-center justify-end gap-[3px] text-[#e4572e]">
            {Array.from({ length: BARS }, (_, i) => (
              <span
                key={i}
                ref={(el) => {
                  barsRef.current[i] = el;
                }}
                className="h-[3px] w-[3px] shrink-0 rounded-full bg-current opacity-30"
              />
            ))}
          </div>
        ) : (
          <span className="col-start-1 row-start-1 flex items-center gap-2 text-[15px] leading-6 text-amber-800 md:text-base">
            <Spinner />
            Transcribing…
          </span>
        )}
        <span className="sr-only" aria-live="polite">
          {live ? "Listening" : "Transcribing"}
        </span>
      </div>

      <button
        type="button"
        onClick={onStop}
        disabled={!live}
        aria-label="Done speaking"
        title="Done speaking"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-linear-to-b from-[#fb923c] to-[#e03e22] text-white shadow-sm shadow-orange-900/30 transition hover:scale-105 hover:brightness-105 active:scale-95 disabled:opacity-30 disabled:hover:scale-100"
      >
        <StopIcon />
      </button>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="5" y="5" width="14" height="14" rx="3" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="animate-spin" aria-hidden>
      <path d="M21 12a9 9 0 0 1-9 9" />
      <path d="M3 12a9 9 0 0 1 9-9" opacity="0.3" />
    </svg>
  );
}
