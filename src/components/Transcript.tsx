"use client";

import { useEffect, useRef } from "react";
import { LogoMark } from "./Logo";
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
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <LogoMark className="mb-4 h-10 w-auto text-amber-500" />
        <h2 className="text-xl font-semibold tracking-tight text-neutral-900">Good to see you</h2>
        <p className="mt-1.5 text-sm text-neutral-500">What would you like to learn today?</p>
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
                : "max-w-[90%] rounded-2xl rounded-bl-sm bg-white px-3.5 py-2 text-sm text-neutral-800 shadow-sm ring-1 ring-amber-100"
            }
          >
            {m.role === "assistant" && (
              <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">Indica</div>
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
