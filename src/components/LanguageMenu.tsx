"use client";

import { useEffect, useRef, useState } from "react";
import { LANGUAGES } from "@/lib/languages";

/**
 * Themed replacement for the native <select>: a popover list that shows each
 * language in its own script with an English gloss, and a check on the active
 * one. Same contract as the old select — it just calls onChange(code).
 */
export default function LanguageMenu({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = LANGUAGES.find((l) => l.code === value) ?? LANGUAGES[0];

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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Language"
        className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white py-1.5 pl-2 pr-1.5 text-xs font-medium text-neutral-700 shadow-sm transition hover:border-neutral-300 hover:bg-neutral-50 active:scale-95"
      >
        <GlobeIcon />
        <span className="max-w-[72px] truncate">{current.native}</span>
        <ChevronIcon className={open ? "rotate-180 transition" : "transition"} />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute right-0 z-50 mt-1.5 max-h-[min(60vh,22rem)] w-56 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1 shadow-xl ring-1 ring-black/5"
        >
          {LANGUAGES.map((l) => {
            const active = l.code === value;
            return (
              <li key={l.code}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(l.code);
                    setOpen(false);
                  }}
                  className={
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition " +
                    (active ? "bg-amber-50 text-amber-900" : "text-neutral-700 hover:bg-neutral-100")
                  }
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium leading-tight">{l.native}</span>
                    <span className="block truncate text-[11px] leading-tight text-neutral-400">{l.label}</span>
                  </span>
                  {active && <CheckIcon />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function GlobeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-neutral-500">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
    </svg>
  );
}

function ChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={"text-neutral-400 " + className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-amber-600">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}
