import type { DrawOp } from "../../schema";
import { measureText } from "../measure";

/**
 * Shared helpers for the deterministic diagram primitives. Each primitive is a
 * pure `expand(op) -> Expanded` function that lowers a high-level op into the
 * low-level draw ops the player already animates, with geometry computed by code
 * so the result can never overlap itself.
 */

export type Box = { x: number; y: number; w: number; h: number };
export type Expanded = { ops: DrawOp[]; bbox: Box; label: string };

export { measureText };

export const TEXT_H = 18; // rough rendered height of one text line

/** A "nice" tick step (1/2/5 x 10^n) giving roughly ten intervals across the span. */
export function niceStep(span: number): number {
  const raw = (Math.abs(span) || 1) / 10;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
}

/** Trim float noise: 3 -> "3", 0.5 -> "0.5", 1.333333 -> "1.33". */
export function fmt(v: number): string {
  return String(Number(v.toFixed(2)));
}

/** Even tick values from the first multiple of step at/after min, up to max (capped). */
export function tickValues(min: number, max: number, step: number, cap = 60): number[] {
  const out: number[] = [];
  const first = Math.ceil(min / step - 1e-9) * step;
  for (let v = first; v <= max + 1e-9 && out.length <= cap; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** 1-D de-collision: nudge boxes right so none overlaps its left neighbour (keeps order). */
export function spreadX(labels: { x1: number; x2: number }[], gap = 8): void {
  const order = labels.map((_, i) => i).sort((a, b) => labels[a].x1 - labels[b].x1);
  let right = -Infinity;
  for (const i of order) {
    const w = labels[i].x2 - labels[i].x1;
    if (labels[i].x1 < right + gap) {
      labels[i].x1 = right + gap;
      labels[i].x2 = labels[i].x1 + w;
    }
    right = labels[i].x2;
  }
}

export const boundsOf = (pts: { x: number; y: number }[]): Box => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};
