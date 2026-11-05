"use client";

import { useEffect, useState } from "react";

/**
 * The board's own menu, opened by double-clicking (or two-finger tapping) the
 * canvas.
 *
 * Excalidraw's export dialog is switched off in Whiteboard's UIOptions, because
 * its menus do not belong on a board the student cannot draw on. But the student
 * does want their notes afterwards, so this is the one affordance that gives
 * them back: the current page as PNG or SVG, and the whole session as a PDF.
 *
 * Double-click is the gesture because the board has no chrome of its own and
 * nothing else uses it — a single click would fire while Indica is drawing, and
 * a visible button would sit on top of the lesson for the whole session.
 */
export default function BoardMenu({
  open,
  at,
  onClose,
  onSavePng,
  onSaveSvg,
  onSavePdf,
  pageCount,
  busy,
}: {
  open: boolean;
  /** Viewport coordinates of the double-click, so the menu opens under it. */
  at: { x: number; y: number } | null;
  onClose: () => void;
  onSavePng: () => void;
  onSaveSvg: () => void;
  onSavePdf: () => void;
  /** How many pages the PDF would contain, shown on the row. */
  pageCount: number;
  /** Set while the PDF is rendering: "Preparing 3 of 12…" or null. */
  busy: string | null;
}) {
  // Esc closes, like every other transient surface here.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !at) return null;

  // Keep the panel on screen when the click lands near an edge.
  const W = 248;
  const H = 210;
  const left = Math.min(at.x, (typeof window === "undefined" ? 1280 : window.innerWidth) - W - 12);
  const top = Math.min(at.y, (typeof window === "undefined" ? 720 : window.innerHeight) - H - 12);

  return (
    <>
      {/* Click-away. Transparent, above the canvas, below the panel. */}
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div
        role="menu"
        aria-label="Board options"
        style={{ left: Math.max(12, left), top: Math.max(12, top), width: W }}
        // Fully opaque, not bg-white/95: a translucent panel let whatever sat
        // behind it read through, which is how Excalidraw's own menu became
        // visible under ours in the first place.
        className="fixed z-50 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl ring-1 ring-black/5"
      >
        <div className="border-b border-neutral-100 bg-neutral-50/80 px-3.5 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Save your notes</p>
        </div>

        <div className="p-1.5">
          <Row
            onClick={onSavePdf}
            disabled={!!busy || pageCount === 0}
            icon={<PdfIcon />}
            title={busy ?? "Download as PDF"}
            detail={
              busy
                ? "Rendering each page…"
                : pageCount === 0
                  ? "Nothing on the board yet"
                  : `All ${pageCount} page${pageCount === 1 ? "" : "s"}, landscape`
            }
            primary
          />
          <Row onClick={onSavePng} disabled={!!busy} icon={<ImageIcon />} title="Save this page as PNG" detail="The page on screen" />
          <Row onClick={onSaveSvg} disabled={!!busy} icon={<VectorIcon />} title="Save this page as SVG" detail="Vector, scales cleanly" />
        </div>
      </div>
    </>
  );
}

function Row({
  onClick,
  disabled,
  icon,
  title,
  detail,
  primary,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  title: string;
  detail: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={
        "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-45 " +
        (disabled ? "" : "hover:bg-amber-50")
      }
    >
      <span
        className={
          "grid h-8 w-8 shrink-0 place-items-center rounded-lg " +
          (primary ? "bg-amber-100 text-amber-700" : "bg-neutral-100 text-neutral-500")
        }
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-neutral-800">{title}</span>
        <span className="block truncate text-[11.5px] text-neutral-500">{detail}</span>
      </span>
    </button>
  );
}

/**
 * Double-click / two-finger-tap detection for the board.
 *
 * `dblclick` alone is not enough: on a Mac trackpad a two-finger tap is a
 * secondary click (`contextmenu`), which is the gesture the user asked for, and
 * on a touchscreen neither fires reliably — so a two-tap fallback is timed by
 * hand. All three land on the same menu.
 */
export function useBoardMenu() {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let lastTap = 0;
    const show = (x: number, y: number) => {
      setAt({ x, y });
      setOpen(true);
    };
    // Only gestures that land on the canvas itself: the menu must not open from
    // a double-click on the Doubt button or the page rail.
    const onCanvas = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest(".excalidraw") && !t.closest("button,[role=menu],[role=dialog]");

    const onDbl = (e: MouseEvent) => {
      if (!onCanvas(e.target)) return;
      // Excalidraw treats a double-click on the canvas as "start editing text
      // here". The board is in view mode so no editor should appear, but the
      // gesture is ours now either way — swallow it rather than rely on that.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      show(e.clientX, e.clientY);
    };
    const onCtx = (e: MouseEvent) => {
      if (!onCanvas(e.target)) return;
      // Three separate suppressions, because three different things want to
      // open a menu on this gesture:
      //  - preventDefault: the BROWSER's own context menu.
      //  - stopPropagation + stopImmediatePropagation: EXCALIDRAW's. It binds
      //    `handleCanvasContextMenu` on the canvas itself, so preventing the
      //    default does nothing to it — its menu opened anyway and showed
      //    through ours. This listener runs in the CAPTURE phase (see the
      //    addEventListener below), which is the only way to get in front of a
      //    handler attached further down the tree.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      show(e.clientX, e.clientY);
    };
    const onTouch = (e: TouchEvent) => {
      if (!onCanvas(e.target)) return;
      // Two fingers down at once is the same intent as a trackpad two-finger tap.
      if (e.touches.length >= 2) {
        const t0 = e.touches[0];
        show(t0.clientX, t0.clientY);
        return;
      }
      const now = Date.now();
      if (now - lastTap < 320) {
        const t0 = e.changedTouches[0] ?? e.touches[0];
        if (t0) show(t0.clientX, t0.clientY);
        lastTap = 0;
      } else lastTap = now;
    };

    // Capture phase (the `true`): these have to run BEFORE the handlers
    // Excalidraw attaches inside the canvas, or its own menu is already open by
    // the time ours is asked for.
    window.addEventListener("dblclick", onDbl, true);
    window.addEventListener("contextmenu", onCtx, true);
    window.addEventListener("touchstart", onTouch, { passive: true, capture: true });
    return () => {
      window.removeEventListener("dblclick", onDbl, true);
      window.removeEventListener("contextmenu", onCtx, true);
      window.removeEventListener("touchstart", onTouch, true);
    };
  }, []);

  return { open, at, close: () => setOpen(false) };
}

function PdfIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" strokeLinejoin="round" />
      <path d="M14 3v5h5" strokeLinejoin="round" />
      <path d="M9 13h6M9 16.5h4" strokeLinecap="round" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" strokeLinejoin="round" />
    </svg>
  );
}

function VectorIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="3" y="3" width="4" height="4" rx="1" />
      <rect x="17" y="3" width="4" height="4" rx="1" />
      <rect x="3" y="17" width="4" height="4" rx="1" />
      <rect x="17" y="17" width="4" height="4" rx="1" />
      <path d="M7 5h10M5 7v10M19 7v10M7 19h10" />
    </svg>
  );
}
