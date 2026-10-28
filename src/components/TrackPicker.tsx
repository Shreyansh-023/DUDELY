"use client";

import type { TutorTrack } from "@/lib/schema";

/**
 * The first choice of a session: understand a topic, or solve a question.
 *
 * These are two genuinely different pipelines, not two phrasings of one. "Learn"
 * asks how familiar the student is, designs a lesson plan and teaches it step by
 * step. "Solve" skips all of that — it writes the question on the board and
 * explains the solution from the first word. Asking up front is what lets the
 * solve track start solving immediately instead of interviewing the student first.
 *
 * Shown full-screen before the first question and dismissed for the rest of the
 * session; the header keeps a small toggle for changing track later.
 */
export default function TrackPicker({ onPick }: { onPick: (track: TutorTrack) => void }) {
  return (
    <div className="absolute inset-0 z-20 grid place-items-center overflow-y-auto bg-[#fffdf7]/80 p-6 backdrop-blur-sm">
      <div className="w-full max-w-xl">
        <h2 className="text-center text-lg font-semibold text-amber-900">What would you like to do?</h2>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <TrackCard
            onClick={() => onPick("learn")}
            title="Understand a topic"
            tagline="Learn it step by step"
            icon={<BookIcon />}
          />
          <TrackCard
            onClick={() => onPick("solve")}
            title="Solve questions"
            tagline="Straight to the working"
            icon={<PencilIcon />}
          />
        </div>
      </div>
    </div>
  );
}

function TrackCard({
  onClick,
  title,
  tagline,
  icon,
}: {
  onClick: () => void;
  title: string;
  tagline: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-full flex-col items-start rounded-2xl border border-amber-200/60 bg-white/90 p-5 text-left shadow-lg shadow-amber-900/5 transition hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
    >
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-100 text-amber-700 transition group-hover:bg-amber-500 group-hover:text-white">
        {icon}
      </span>
      <span className="mt-3 text-[15px] font-semibold text-neutral-800">{title}</span>
      <span className="mt-0.5 text-[12.5px] text-amber-800/80">{tagline}</span>
    </button>
  );
}

function BookIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5H5.5A1.5 1.5 0 0 1 4 16V5.5Z" strokeLinejoin="round" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 0 20 16V5.5Z" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5 4 20Z" strokeLinejoin="round" />
      <path d="M14.5 6.5 17.5 9.5" />
    </svg>
  );
}
