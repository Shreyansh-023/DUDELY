import type { DrawOp } from "../../schema";
import { measureText } from "../measure";

/**
 * Shared helpers for the deterministic diagram primitives. Each primitive is a
 * pure `expand(op) -> Expanded` function that lowers a high-level op into the
 * low-level draw ops the player already animates, with geometry computed by code
 * so the result can never overlap itself.
 */

export type Box = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

/**
 * The named parts of a figure, in the same coordinates as its ops. The player
 * shifts them along with the figure when it places it and keeps them in a
 * registry, so a later op can say "the angle at A" and land on the committed
 * vertex rather than on wherever the model imagined it (see lib/canvas/anchors).
 */
export type Anchors = {
  /** Named points: vertex labels ("A"), positional aliases ("v0"), "centroid". */
  points: Record<string, Pt>;
  /** Vertex name -> index into `outline`. */
  vertexIndex: Record<string, number>;
  /** Edge name in both orders ("AB", "BA") -> index of the drawn edge (outline[i] -> outline[i+1]). */
  edgeIndex: Record<string, number>;
  /** The drawn outline, in vertex order, for label placement around it. */
  outline: Pt[];
  closed: boolean;
};

export type Expanded = { ops: DrawOp[]; bbox: Box; label: string; anchors?: Anchors };

export { measureText };

export const TEXT_H = 18; // rough rendered height of one text line

/**
 * Rendered box of a (possibly multi-line) label: the widest line by the number
 * of lines. Line height scales with the font so a `md`/`lg` label is measured
 * as tall as it actually draws.
 */
export function textBox(text: string, fontPx: number): { w: number; h: number } {
  const lines = String(text ?? "").split("\n");
  const w = Math.max(0, ...lines.map((l) => measureText(l, fontPx)));
  const lineH = Math.max(TEXT_H, Math.round(fontPx * 1.25));
  return { w, h: lines.length * lineH };
}

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

/**
 * Figures whose drawn size follows their numeric geometry, so shrinking those
 * numbers shrinks the figure. A table, tree, graph, Punnett square, reaction or
 * circuit is sized by its text instead, and a smaller number would not make it
 * smaller — those are never scaled, only moved to a page with room.
 */
export const SCALABLE_OPS: ReadonlySet<string> = new Set([
  "polygon",
  "axes",
  "numberline",
  "bars",
  "fraction",
  "circles",
  "solid",
  "net",
  "wave",
  "pie",
  "incline",
  "vector",
  "optics",
  "labeled",
  "angle",
  "curvearrow",
  "rect",
  "ellipse",
  "diamond",
  "line",
  "arrow",
  "highlight",
]);

/**
 * A copy of `op` with every length and position multiplied by `s`, so a figure
 * that would not fit the room it has can be drawn smaller and still read as the
 * same figure. Labels keep their font size: text that shrank with the figure
 * would become unreadable before the figure became small.
 */
export function scaleOp(op: DrawOp, s: number): DrawOp {
  if (s === 1) return op;
  const n = (v: number | null | undefined): number | null | undefined => (typeof v === "number" ? v * s : v);
  const out: DrawOp = {
    ...op,
    x: n(op.x),
    y: n(op.y),
    w: n(op.w),
    h: n(op.h),
    x2: n(op.x2),
    y2: n(op.y2),
    r: n(op.r),
    d: n(op.d),
    w2: n(op.w2),
    amp: n(op.amp),
    bow: n(op.bow),
    scale: n(op.scale),
  };
  if (op.radii) out.radii = op.radii.map((v) => v * s);
  if (op.points) out.points = op.points.map((p) => ({ ...p, x: p.x * s, y: p.y * s }));
  return out;
}

/** Smallest extent a figure is drawn at; a model that gives a triangle in real
 *  units ("sides 5 and 10") would otherwise draw it 30px wide. */
const MIN_FIGURE_PX = 160;
const READABLE_FIGURE_PX = 280;

/**
 * A figure whose geometry is given in tiny numbers, scaled up to a readable
 * size. Only the numeric geometry grows (labels keep their font size), and
 * only figures whose size follows that geometry are touched.
 */
export function readableSize(op: DrawOp): DrawOp {
  if (!SCALABLE_OPS.has(op.op)) return op;
  let extent = 0;
  if (op.points && op.points.length >= 2) {
    const xs = op.points.map((p) => p.x);
    const ys = op.points.map((p) => p.y);
    extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  } else if (op.radii?.length) {
    extent = 2 * Math.max(...op.radii);
  } else {
    extent = Math.max(op.w ?? 0, op.h ?? 0);
  }
  if (extent > 0 && extent < MIN_FIGURE_PX) return legibleAspect(scaleOp(op, READABLE_FIGURE_PX / extent));
  return legibleAspect(op);
}

/** A polygon thinner than this (long side : short side) is opened out until it is not. */
const MAX_ASPECT = 5;

/**
 * A "very flat" or "very tall" triangle drawn to illustrate a limiting case is
 * invisible at 280 x 12 px: the thin axis is stretched until the figure is at
 * most MAX_ASPECT:1. The angles change, but a sketch of a limit is not to
 * scale anyway, and a figure nobody can see teaches nothing.
 */
function legibleAspect(op: DrawOp): DrawOp {
  if (op.op !== "polygon" || !op.points || op.points.length < 3) return op;
  const xs = op.points.map((p) => p.x);
  const ys = op.points.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  if (!(w > 0) || !(h > 0)) return op;
  if (w >= h * MAX_ASPECT && h > 0) {
    const f = w / MAX_ASPECT / h;
    return { ...op, points: op.points.map((p) => ({ ...p, y: y0 + (p.y - y0) * f })) };
  }
  if (h >= w * MAX_ASPECT && w > 0) {
    const f = h / MAX_ASPECT / w;
    return { ...op, points: op.points.map((p) => ({ ...p, x: x0 + (p.x - x0) * f })) };
  }
  return op;
}

