"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GRADES, scienceSlot, subjectLabelFor, subjectsForGrade, type Grade, type SubjectId } from "@/lib/curriculum";
import { LANGUAGES } from "@/lib/languages";
import type { TutorTrack } from "@/lib/schema";
import { LogoMark, Wordmark } from "./Logo";

/**
 * Setting up a class: one decision per screen, with a progress bar and a way
 * back.
 *
 * This replaces a single screen that stacked all four choices as rows of pills.
 * That version put twenty-two targets of identical visual weight in front of a
 * student at once — ten classes, two subjects, twelve languages — and selecting
 * them turned the page orange. The established guidance is specific about why
 * that fails: chips are a pattern for roughly three to six options, and more
 * than two rows of them makes each one harder to scan, not easier. Neither the
 * class list nor the language list is a chip problem.
 *
 * So each step uses the control its own option set actually calls for:
 *   class    — a numeric grid. Ten numbers want rows and columns, not a
 *              wrapping flow, and a 5x2 grid of big digits is read at a glance.
 *   subject  — two descriptive cards. Two options with something to say about
 *              each is the case cards exist for.
 *   language — a filterable list. Twelve options is past what chips carry, and
 *              a student who wants Malayalam should type three letters rather
 *              than hunt a grid in a script they may not read.
 *   mode     — two cards again, and the commit point: picking one starts the
 *              class, so nothing else may share that screen.
 *
 * Choosing advances automatically. There is no Next button on the first three
 * steps because the choice IS the submit — a confirm step after a single tap is
 * a second decision about a decision already made.
 */

type Step = "class" | "subject" | "language" | "mode";

export default function StartScreen({
  grade,
  subject,
  language,
  onGrade,
  onSubject,
  onLanguage,
  onStart,
  ready,
}: {
  grade: Grade | null;
  subject: SubjectId | null;
  language: string;
  onGrade: (g: Grade) => void;
  onSubject: (s: SubjectId) => void;
  onLanguage: (code: string) => void;
  onStart: (track: TutorTrack) => void;
  /** The board and config have loaded; until then starting would do nothing. */
  ready: boolean;
}) {
  // Resume where the student left off. A returning student has their class and
  // subject in localStorage already, so they should land on the mode step, not
  // be marched through four screens to change nothing.
  const [step, setStep] = useState<Step>(() =>
    grade == null ? "class" : subject == null ? "subject" : "mode",
  );
  const order: Step[] = ["class", "subject", "language", "mode"];
  const at = order.indexOf(step);

  const go = (next: Step) => setStep(next);
  const back = () => {
    if (at > 0) setStep(order[at - 1]);
  };

  return (
    <div className="absolute inset-0 z-30 overflow-y-auto bg-[#fffdf7]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(55rem_38rem_at_50%_-12%,rgba(251,191,36,0.18),transparent)]"
      />

      <div className="relative mx-auto flex min-h-full w-full max-w-[29rem] flex-col px-5 py-7">
        {/* Progress. Four steps, named, so the student knows how long this is —
            a flow that says how many screens it has is abandoned less than one
            that reveals them one surprise at a time. */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={back}
            disabled={at === 0}
            aria-label="Back"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-amber-100/70 hover:text-neutral-800 disabled:pointer-events-none disabled:opacity-0"
          >
            <BackIcon />
          </button>
          <div className="flex flex-1 gap-1.5">
            {order.map((s, i) => (
              <span
                key={s}
                className={
                  "h-1.5 flex-1 rounded-full transition-colors duration-300 " +
                  (i <= at ? "bg-amber-500" : "bg-amber-900/10")
                }
              />
            ))}
          </div>
          <span className="w-9 shrink-0 text-right text-[11px] font-medium tabular-nums text-neutral-400">
            {at + 1}/4
          </span>
        </div>

        {/* `justify-center` on the short steps keeps them optically centred;
            the language step is tall, so it stretches instead of sitting in a
            squeezed band between two large gaps. */}
        <div
          className={
            "flex flex-1 flex-col py-6 " + (step === "language" ? "justify-start pt-10" : "justify-center")
          }
        >
          {step === "class" && (
            <Panel
              title="Which class are you in?"
              sub="Indica teaches straight from your NCERT textbook."
            >
              <div className="grid grid-cols-5 gap-2.5">
                {GRADES.map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => {
                      onGrade(g as Grade);
                      // Classes 1-2 have only Maths, so there is nothing to ask
                      // on the subject step — pick it and skip straight past.
                      const only = subjectsForGrade(g as Grade);
                      if (only.length === 1) {
                        onSubject(only[0]);
                        go("language");
                      } else go("subject");
                    }}
                    aria-pressed={g === grade}
                    className={
                      "grid aspect-square place-items-center rounded-2xl border text-[19px] font-semibold tabular-nums transition active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 " +
                      (g === grade
                        ? "border-amber-500 bg-amber-500 text-white shadow-md shadow-amber-900/20"
                        : "border-neutral-200/90 bg-white text-neutral-700 shadow-sm hover:-translate-y-0.5 hover:border-amber-300 hover:text-amber-900 hover:shadow-md")
                    }
                  >
                    {g}
                  </button>
                ))}
              </div>
            </Panel>
          )}

          {step === "subject" && grade != null && (
            <Panel title="Which subject?" sub={`NCERT Class ${grade}`}>
              <div className="grid gap-3">
                {subjectsForGrade(grade).map((s) => {
                  const science = scienceSlot(grade);
                  return (
                    <OptionRow
                      key={s}
                      selected={s === subject}
                      onClick={() => {
                        onSubject(s);
                        go("language");
                      }}
                      emoji={s === "maths" ? "📐" : (science?.emoji ?? "🔬")}
                      title={subjectLabelFor(grade, s)}
                      detail={
                        s === "maths"
                          ? "Numbers, algebra, geometry — worked on the board"
                          : grade <= 5
                            ? "The world around you, explained simply"
                            : "Physics, chemistry and biology, with diagrams"
                      }
                    />
                  );
                })}
              </div>
            </Panel>
          )}

          {step === "language" && (
            <LanguageStep
              value={language}
              onPick={(code) => {
                onLanguage(code);
                go("mode");
              }}
            />
          )}

          {step === "mode" && (
            <Panel title="How would you like to study?" sub="You can talk to Indica the whole way through.">
              <div className="grid gap-3">
                {/* Study mode leads. Two identical cards make the student
                    weigh a choice they have no basis to weigh yet; giving the
                    fuller experience the weight says which one to take if you
                    do not already know, without taking the other away. */}
                <OptionRow
                  onClick={() => ready && onStart("learn")}
                  disabled={!ready}
                  emoji="📖"
                  title="Study mode"
                  detail="Indica plans the chapter and teaches it page by page, checking in as you go."
                  cta
                />
                <OptionRow
                  onClick={() => ready && onStart("solve")}
                  disabled={!ready}
                  emoji="✏️"
                  title="Question session"
                  detail="Name an exercise or example and Indica works the whole solution on the board."
                />
              </div>
              <Summary grade={grade} subject={subject} language={language} onEdit={() => go("class")} />
            </Panel>
          )}
        </div>

        <footer className="flex flex-col items-center gap-1.5 pb-1 text-center">
          <span className="flex items-center gap-1.5 text-amber-500">
            <LogoMark className="h-4 w-auto" />
            <span className="text-amber-900/80">
              <Wordmark className="h-3 w-auto" />
            </span>
          </span>
          <p className="text-[11.5px] text-amber-900/50">
            {ready ? "Your own teacher on a blackboard" : "Getting the board ready…"}
          </p>
        </footer>
      </div>
    </div>
  );
}

/** One step's heading and body. The heading is a question, because every step
 *  asks exactly one. */
function Panel({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="animate-[fadeUp_240ms_ease-out]">
      <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-neutral-900">{title}</h1>
      {sub && <p className="mt-1.5 text-[13px] text-neutral-500">{sub}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}

/**
 * A full-width option with room to say what it is.
 *
 * `cta` marks the two that start the session: they get the amber treatment,
 * because on that screen they are the action and everything else is context.
 * Elsewhere selection is shown with a quiet ring and a tick rather than a block
 * of colour — a list where the chosen row is the loudest thing on screen is
 * hard to read past.
 */
function OptionRow({
  onClick,
  selected,
  disabled,
  emoji,
  title,
  detail,
  cta,
}: {
  onClick: () => void;
  selected?: boolean;
  disabled?: boolean;
  emoji: string;
  title: string;
  detail: string;
  cta?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={
        "group flex w-full items-center gap-3.5 rounded-2xl border p-4 text-left transition enabled:hover:-translate-y-0.5 enabled:hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-50 " +
        (cta
          ? "border-amber-200 bg-white shadow-md shadow-amber-900/5 enabled:hover:border-amber-400"
          : selected
            ? "border-amber-400 bg-amber-50/70 shadow-sm"
            : "border-neutral-200/90 bg-white shadow-sm enabled:hover:border-amber-300")
      }
    >
      <span
        className={
          "grid h-11 w-11 shrink-0 place-items-center rounded-xl text-[20px] transition " +
          (cta ? "bg-amber-100 group-enabled:group-hover:bg-amber-200" : "bg-neutral-100")
        }
      >
        {emoji}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-neutral-900">{title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-snug text-neutral-500">{detail}</span>
      </span>
      <span className="shrink-0 text-amber-500">{selected ? <TickIcon /> : <ChevronIcon />}</span>
    </button>
  );
}

/**
 * The language step: a filterable list.
 *
 * Twelve options is past the size chips handle, and a grid of twelve scripts is
 * the hardest kind of list to scan — the student is looking for a shape, not a
 * word. A search box turns that into typing three letters. The two most-used
 * registers (English and Hinglish) sit at the top under their own heading,
 * because they are what most of this audience actually picks and burying them
 * alphabetically would be a quiet tax on the common case.
 */
function LanguageStep({ value, onPick }: { value: string; onPick: (code: string) => void }) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Autofocus only where a keyboard is a help, not where it covers the list.
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, []);

  const needle = q.trim().toLowerCase();
  const matches = useMemo(
    () =>
      LANGUAGES.filter(
        (l) => !needle || l.label.toLowerCase().includes(needle) || l.native.toLowerCase().includes(needle),
      ),
    [needle],
  );
  const common = matches.filter((l) => l.code === "en" || l.code === "en-IN");
  const rest = matches.filter((l) => l.code !== "en" && l.code !== "en-IN");

  return (
    <Panel title="Which language should Indica speak?" sub="This is how Indica talks, listens and writes on the board.">
      <div className="relative">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400">
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search languages…"
          aria-label="Search languages"
          className="h-11 w-full rounded-xl border border-neutral-200 bg-white pl-10 pr-3 text-[14px] text-neutral-800 shadow-sm outline-none transition placeholder:text-neutral-400 focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
        />
      </div>

      <div className="relative mt-3">
        <div className="max-h-[min(58vh,30rem)] space-y-1 overflow-y-auto pb-5 pr-0.5">
          {common.length > 0 && (
            <>
              <Legend>Most used</Legend>
              {common.map((l) => (
                <LanguageRow key={l.code} l={l} selected={l.code === value} onPick={onPick} />
              ))}
            </>
          )}
          {rest.length > 0 && (
            <>
              {common.length > 0 && <Legend>All languages</Legend>}
              {rest.map((l) => (
                <LanguageRow key={l.code} l={l} selected={l.code === value} onPick={onPick} />
              ))}
            </>
          )}
          {matches.length === 0 && (
            <p className="px-1 py-6 text-center text-[13px] text-neutral-400">No language matches “{q}”.</p>
          )}
        </div>
        {/* Tells the list it continues, instead of ending on a half-drawn row. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-[#fffdf7] to-transparent"
        />
      </div>
    </Panel>
  );
}

function Legend({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-neutral-400">
      {children}
    </p>
  );
}

function LanguageRow({
  l,
  selected,
  onPick,
}: {
  l: (typeof LANGUAGES)[number];
  selected: boolean;
  onPick: (code: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(l.code)}
      aria-pressed={selected}
      className={
        "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 " +
        (selected
          ? "border-amber-400 bg-amber-50/70"
          : "border-transparent hover:border-neutral-200 hover:bg-neutral-50")
      }
    >
      <span className="min-w-0 flex-1">
        {/* The native name leads: a student looking for Malayalam is looking for
            മലയാളം, and the English name is the gloss, not the label. */}
        <span className="block truncate text-[14px] font-medium leading-tight text-neutral-900">{l.native}</span>
        <span className="block truncate text-[11.5px] leading-tight text-neutral-500">{l.label}</span>
      </span>
      {selected && (
        <span className="shrink-0 text-amber-500">
          <TickIcon />
        </span>
      )}
    </button>
  );
}

/** What has been chosen, on the last step, with one way back to change it. */
function Summary({
  grade,
  subject,
  language,
  onEdit,
}: {
  grade: Grade | null;
  subject: SubjectId | null;
  language: string;
  onEdit: () => void;
}) {
  const lang = LANGUAGES.find((l) => l.code === language);
  const bits = [
    grade != null ? `Class ${grade}` : null,
    grade != null && subject != null ? subjectLabelFor(grade, subject) : null,
    lang?.native,
  ].filter(Boolean);
  return (
    <button
      type="button"
      onClick={onEdit}
      className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-xl py-2 text-[12.5px] text-neutral-500 transition hover:bg-amber-50 hover:text-neutral-700"
    >
      <span>{bits.join(" · ")}</span>
      <span className="font-medium text-amber-700">Change</span>
    </button>
  );
}

function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="text-neutral-300">
      <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M4.5 12.5l5 5 10-11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" strokeLinecap="round" />
    </svg>
  );
}
