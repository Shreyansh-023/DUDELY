"use client";

import { useEffect, useRef, useState } from "react";
import {
  GRADES,
  scienceSlot,
  subjectLabelFor,
  subjectsForGrade,
  type Grade,
  type SubjectId,
} from "@/lib/curriculum";

/**
 * Lets the student pick the NCERT class (1-10) and subject they want to
 * study. The pair names one textbook, which is what lets the RAG backend
 * shrink its vector search to that book's embeddings.
 *
 * Two-step flow: class first, then the subjects actually published for that
 * class. Classes 1-2 have Maths only (no Science/EVS), 3-5 have Maths + EVS
 * (Looking Around), 6-10 have Maths + Science. The "science" slot keeps the
 * same backend id across EVS and Science — only the label changes.
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
  // Which step the popover shows. When the trigger opens, resume on whichever
  // step still needs attention; the back button on step 2 returns to step 1.
  const [step, setStep] = useState<"class" | "subject">(grade == null ? "class" : "subject");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep(grade == null ? "class" : "subject");
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
  }, [open, grade]);

  const ready = grade != null && subject != null;
  const summary = ready
    ? `Class ${grade} · ${subjectLabelFor(grade as Grade, subject as SubjectId)}`
    : grade != null
      ? `Class ${grade} · Pick subject`
      : "Pick class & subject";

  const available = grade != null ? subjectsForGrade(grade) : [];

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
          className="absolute left-0 z-50 mt-1.5 w-72 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl ring-1 ring-black/5"
        >
          {/* Step indicator — subtle breadcrumb so the two-step flow is obvious. */}
          <div className="flex items-center gap-1.5 border-b border-neutral-100 bg-neutral-50/70 px-3 py-2 text-[11px] font-medium text-neutral-500">
            <StepDot active={step === "class"} done={grade != null && step !== "class"} />
            <button
              type="button"
              onClick={() => setStep("class")}
              className={
                "transition " +
                (step === "class" ? "text-neutral-900" : "hover:text-neutral-700")
              }
            >
              1. Class{grade != null ? ` ${grade}` : ""}
            </button>
            <ChevronRightIcon className="text-neutral-300" />
            <StepDot active={step === "subject"} done={subject != null && step === "subject"} muted={grade == null} />
            <button
              type="button"
              disabled={grade == null}
              onClick={() => grade != null && setStep("subject")}
              className={
                "transition " +
                (grade == null
                  ? "cursor-not-allowed text-neutral-300"
                  : step === "subject"
                    ? "text-neutral-900"
                    : "hover:text-neutral-700")
              }
            >
              2. Subject
            </button>
          </div>

          {step === "class" && (
            <div className="p-3">
              <p className="px-0.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                Select class
              </p>
              <div className="grid grid-cols-5 gap-1.5">
                {GRADES.map((g) => {
                  const active = g === grade;
                  return (
                    <button
                      key={g}
                      type="button"
                      onClick={() => {
                        // Changing class may invalidate the current subject
                        // (Class 1 picked while subject was "science", say).
                        // Drop the subject in that case so the user re-picks.
                        const nextSubject =
                          subject != null && subjectsForGrade(g as Grade).includes(subject)
                            ? subject
                            : null;
                        onChange({ grade: g as Grade, subject: nextSubject });
                        setStep("subject");
                      }}
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

          {step === "subject" && grade != null && (
            <div className="p-3">
              <div className="flex items-center justify-between pb-1.5">
                <p className="px-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  Select subject
                </p>
                <button
                  type="button"
                  onClick={() => setStep("class")}
                  className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700"
                >
                  <ChevronLeftIcon /> Class {grade}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {available.map((id) => {
                  const active = id === subject;
                  const label = subjectLabelFor(grade, id);
                  const emoji =
                    id === "science" ? (scienceSlot(grade)?.emoji ?? "🔬") : "➗";
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        onChange({ grade, subject: id });
                        setOpen(false);
                      }}
                      aria-pressed={active}
                      className={
                        "flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-sm font-medium transition " +
                        (active
                          ? "border-amber-400 bg-amber-50 text-amber-900 ring-1 ring-amber-200"
                          : "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50")
                      }
                    >
                      <span aria-hidden>{emoji}</span>
                      {label}
                    </button>
                  );
                })}
              </div>

            </div>
          )}
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

function ChevronLeftIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function StepDot({
  active,
  done,
  muted,
}: {
  active: boolean;
  done?: boolean;
  muted?: boolean;
}) {
  const cls = muted
    ? "bg-neutral-200"
    : done
      ? "bg-amber-500"
      : active
        ? "bg-neutral-900"
        : "bg-neutral-300";
  return <span aria-hidden className={"inline-block h-1.5 w-1.5 rounded-full " + cls} />;
}
