"use client";

import { useEffect, useRef, useState } from "react";
import { GRADES, SUBJECTS, type Grade, type SubjectId, subjectLabel } from "@/lib/curriculum";

/**
 * Lets the student pick the NCERT class (1-12) and subject (Maths / Science)
 * they want to study. The pair names one textbook, which is what lets the RAG
 * backend shrink its vector search to that book's embeddings.
 *
 * Lives in the chat header. Trigger shows the current choice ("Class 10 ·
 * Science") or an amber call-to-action when nothing is picked yet; clicking it
 * opens a popover with a subject toggle and a grid of classes.
 */
export default function ClassSubjectPicker({
  grade,
  subject,
  onChange,
}: {
  grade: Grade | null;
  subject: SubjectId | null;
  onChange: (next: { grade: Grade | null; subject: SubjectId | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ready = grade != null && subject != null;
  const summary = ready ? `Class ${grade} · ${subjectLabel(subject)}` : "Pick class & subject";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Choose class and subject"
        className={
          "flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-sm transition active:scale-95 " +
          (ready
            ? "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50"
            : "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100")
        }
      >
        <BookIcon className={ready ? "text-neutral-500" : "text-amber-600"} />
        <span className="truncate">{summary}</span>
        <ChevronIcon className={open ? "rotate-180 transition" : "transition"} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Class and subject"
          className="absolute left-0 z-50 mt-1.5 w-64 rounded-2xl border border-neutral-200 bg-white p-3 shadow-xl ring-1 ring-black/5"
        >
          {/* Subject */}
          <p className="px-0.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Subject
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {SUBJECTS.map((s) => {
              const active = s.id === subject;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onChange({ grade, subject: s.id as SubjectId })}
                  aria-pressed={active}
                  className={
                    "flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-sm font-medium transition " +
                    (active
                      ? "border-amber-400 bg-amber-50 text-amber-900 ring-1 ring-amber-200"
                      : "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50")
                  }
                >
                  <span aria-hidden>{s.emoji}</span>
                  {s.label}
                </button>
              );
            })}
          </div>

          {/* Class */}
          <p className="px-0.5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Class
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {GRADES.map((g) => {
              const active = g === grade;
              return (
                <button
                  key={g}
                  type="button"
                  onClick={() => onChange({ grade: g as Grade, subject })}
                  aria-pressed={active}
                  className={
                    "rounded-lg border py-2 text-sm font-medium tabular-nums transition " +
                    (active
                      ? "border-amber-400 bg-amber-500 text-white shadow-sm"
                      : "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50")
                  }
                >
                  {g}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function BookIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" />
      <path d="M18 3v18" />
    </svg>
  );
}

function ChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={"text-neutral-400 " + className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
