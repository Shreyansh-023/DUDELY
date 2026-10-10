"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage } from "./Tutor";

export default function Transcript({ messages, status }: { messages: ChatMessage[]; status: string }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, status]);

  // A failed turn can leave an assistant message with no text; never show an
  // empty "GURU" bubble (pending-with-empty-text is fine — that's the dots).
  const visible = messages.filter((m) => m.role !== "assistant" || m.pending || m.text.trim());

  if (!visible.length) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-5 text-sm text-neutral-500">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">Try asking</p>
        <ul className="mt-2.5 space-y-2">
          {[
            "Newton ka second law samjhao",
            "Why is 2/4 the same as 1/2?",
            "Photosynthesis kaise hota hai?",
            "Solve x² − 5x + 6 = 0 with me",
          ].map((q) => (
            <li
              key={q}
              className="rounded-xl border border-neutral-200/80 bg-white px-3.5 py-2.5 text-[13px] text-neutral-700 shadow-sm transition hover:border-amber-200 hover:bg-amber-50/40"
            >
              “{q}”
            </li>
          ))}
        </ul>
        <p className="mt-4 rounded-xl bg-amber-50/80 px-3.5 py-2.5 text-xs leading-relaxed text-amber-800 ring-1 ring-amber-100">
          Draw your attempt on the board, then ask “is this right?”. Guru looks at what you drew.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
      {visible.map((m) => (
        <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
          <div
            className={
              m.role === "user"
                ? "max-w-[85%] rounded-2xl rounded-br-sm bg-linear-to-b from-amber-500 to-amber-600 px-3.5 py-2 text-sm text-white shadow-sm"
                : "max-w-[90%] rounded-2xl rounded-bl-sm bg-white px-3.5 py-2 text-sm text-neutral-800 shadow-sm ring-1 ring-neutral-200/80"
            }
          >
            {m.role === "assistant" && (
              <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">Guru</div>
            )}
            <p className="whitespace-pre-wrap leading-relaxed">
              {m.text}
              {m.pending && (
                <span className="ml-1 inline-flex gap-0.5 align-middle">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-amber-500 [animation-delay:-0.3s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-amber-500 [animation-delay:-0.15s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-amber-500" />
                </span>
              )}
            </p>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
