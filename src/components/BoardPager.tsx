"use client";

/**
 * The board's own page navigation.
 *
 * Excalidraw has a "Scroll back to content" button of its own, and it is wrong
 * here twice over: it frames the bounding box of the WHOLE book (which lands
 * between pages, usually near the plan) and it writes the viewport itself
 * rather than going through the player. It is hidden in globals.css, and this
 * takes its place under the SAME NAME, in the same spot at the foot of the
 * board — but going back to the page Indica is actually writing on. Above it
 * sits a page readout the student can flip through.
 *
 * The page model lives in BoardPlayer; this subscribes to its snapshot and
 * drives it through `showPage` / `recenter`, which frame a page exactly.
 */
import { useSyncExternalStore } from "react";
import type { BoardPlayer } from "@/lib/canvas/player";

function Chevron({ back }: { back?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points={back ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
    </svg>
  );
}

export default function BoardPager({ player }: { player: BoardPlayer }) {
  const state = useSyncExternalStore(
    (fn) => player.subscribe(fn),
    () => player.getPageState(),
    () => player.getPageState(),
  );
  const { pages, activeIndex, viewIndex, follow } = state;
  if (pages.length < 1 || viewIndex < 0) return null;

  const here = pages[viewIndex];
  // Reading order, not allocation order: down the teaching column, and a step's
  // doubts immediately after the step they belong to.
  const order = [...pages].sort((a, b) => a.row - b.row || a.col - b.col);
  const at = order.findIndex((p) => p.index === viewIndex);
  const prev = at > 0 ? order[at - 1] : null;
  const next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
  // "Off the live page" covers flipping away with the arrows and dragging the
  // board by hand — the player reports the latter through `follow`.
  const lost = activeIndex >= 0 && (!follow || viewIndex !== activeIndex);

  const btn =
    "grid h-7 w-7 place-items-center rounded-full text-neutral-600 transition enabled:hover:bg-black/5 enabled:hover:text-neutral-900 disabled:opacity-30";

  return (
    <>
    <div className="pointer-events-none absolute right-3 top-3 z-20 flex flex-col items-end gap-2">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-white/90 px-1 py-1 shadow ring-1 ring-black/5 backdrop-blur">
        <button
          type="button"
          className={btn}
          disabled={!prev}
          onClick={() => prev && player.showPage(prev.index, { animate: true, manual: true })}
          title="Previous page"
          aria-label="Previous page"
        >
          <Chevron back />
        </button>
        <span className="min-w-18 select-none px-1 text-center text-[11px] font-medium leading-none text-neutral-600">
          {here?.kind === "doubt" ? (
            <span className="text-orange-600">Doubt</span>
          ) : (
            <>
              Page {at + 1}
              <span className="opacity-50"> / {order.length}</span>
            </>
          )}
        </span>
        <button
          type="button"
          className={btn}
          disabled={!next}
          onClick={() => next && player.showPage(next.index, { animate: true, manual: true })}
          title="Next page"
          aria-label="Next page"
        >
          <Chevron />
        </button>
      </div>
    </div>
    {/* The one way back, where Excalidraw put its own: centred at the foot of
        the board, clear of the Doubt button and the presenter on the voice
        stage. It rides ABOVE the lower-third subtitle (inset-x-4 bottom-4,
        ~2rem tall) rather than across it, so a caption and the way back are
        never stacked on the same line. */}
    {lost && (
      <button
        type="button"
        onClick={() => player.recenter()}
        className="absolute bottom-16 left-1/2 z-20 -translate-x-1/2 rounded-full bg-neutral-900/85 px-4 py-2 text-xs font-semibold text-white shadow-lg ring-1 ring-inset ring-white/15 backdrop-blur transition hover:bg-neutral-900 active:scale-95"
      >
        Scroll back to content
      </button>
    )}
    </>
  );
}
