"use client";

/**
 * Rendered text width, used by the diagram expanders to space labels so they
 * can never collide. Excalidraw draws in a hand-drawn font; we measure with a
 * close stand-in and fall back to a per-character estimate when no canvas is
 * available (SSR, or the font has not loaded yet). The estimate is deliberately
 * a touch generous so we err toward MORE spacing, never less.
 */

/**
 * Excalifont FIRST: it is what the board actually draws with (font family 5),
 * and it is what Excalidraw measures against. Naming only Virgil here meant
 * measuring a different font than the one rendered — harmless for a label, but
 * superscript runs are positioned from these widths, so a wrong width drew the
 * exponent on top of the word before it.
 */
const EXCALIDRAW_FONT = '16px Excalifont, Virgil, "Segoe UI", Helvetica, Arial, sans-serif';

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

/**
 * True once Excalifont is actually available to the canvas. Until it is, the
 * browser silently measures a substitute font, and the width comes back wrong
 * (~15% narrow for a long string) rather than failing — which is what put a
 * superscript on top of the word before it on a cold load. The check is cheap
 * and the answer is latched once the font arrives.
 */
let fontReady = false;
function excalifontLoaded(): boolean {
  if (fontReady) return true;
  try {
    fontReady = document.fonts?.check?.('16px Excalifont') ?? false;
  } catch {
    fontReady = false;
  }
  return fontReady;
}

/** Approximate rendered width (px) of `text` at the given font size. */
export function measureText(text: string, fontPx: number): number {
  if (!text) return 0;
  const c = context();
  if (c && excalifontLoaded()) {
    c.font = EXCALIDRAW_FONT.replace("16px", `${fontPx}px`);
    const w = c.measureText(text).width;
    if (w > 0) return w;
  }
  // Fallback: ~0.6em per character is a safe over-estimate for the hand font.
  return text.length * fontPx * 0.6;
}
