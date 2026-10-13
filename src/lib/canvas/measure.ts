"use client";

/**
 * Rendered text width, used by the diagram expanders to space labels so they
 * can never collide. Excalidraw draws in a hand-drawn font; we measure with a
 * close stand-in and fall back to a per-character estimate when no canvas is
 * available (SSR, or the font has not loaded yet). The estimate is deliberately
 * a touch generous so we err toward MORE spacing, never less.
 */

const EXCALIDRAW_FONT = '16px Virgil, "Segoe UI", Helvetica, Arial, sans-serif';

let ctx: CanvasRenderingContext2D | null | undefined;
function context(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Approximate rendered width (px) of `text` at the given font size. */
export function measureText(text: string, fontPx: number): number {
  if (!text) return 0;
  const c = context();
  if (c) {
    c.font = EXCALIDRAW_FONT.replace("16px", `${fontPx}px`);
    const w = c.measureText(text).width;
    if (w > 0) return w;
  }
  // Fallback: ~0.6em per character is a safe over-estimate for the hand font.
  return text.length * fontPx * 0.6;
}
