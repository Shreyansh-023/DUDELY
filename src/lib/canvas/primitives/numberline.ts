import type { DrawOp } from "../../schema";
import { fmt, measureText, niceStep, TEXT_H, tickValues, type Expanded } from "./util";

/**
 * Lowers a high-level `numberline` op into ordinary low-level draw ops (lines,
 * text, ellipses) with geometry computed by code, so the result can NEVER
 * overlap: ticks are evenly spaced by a linear value->pixel scale, tick numbers
 * sit in a reserved band below the line, crowded labels are thinned out
 * (decimated) using measured widths, and marks are de-collided along the axis.
 *
 * The model only declares intent (range, step, points to mark); it never picks
 * coordinates. This is the Manim / JSXGraph "author declares, library places"
 * pattern, kept inside the existing op stream so the hand-drawn animation is
 * untouched.
 */

const FONT_TICK = 16; // "sm" board text
const TICK_HALF = 6; // tick mark half-length
const LABEL_GAP = 12; // gap from line to tick numbers
const LABEL_H = TEXT_H;
const MARK_LABEL_GAP = 24; // gap from line up to a mark's label
const MAX_TICKS = 60; // safety cap

export function expandNumberLine(op: DrawOp): Expanded {
  const pid = (op.id || "nl").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 80;
  const y = op.y ?? 320;
  const w = Math.max(op.w ?? 520, 160);
  // Guard the range so a bad/empty spec still renders something sane.
  let min = op.min ?? -5;
  let max = op.max ?? 5;
  if (!(max > min)) {
    min = -5;
    max = 5;
  }
  // A fractions lesson needs fraction ticks. `niceStep` is decimal by construction
  // (1, 2, 5 x 10^n), so a 0..1 line came out as 0.1 … 0.9 — and a student being told
  // "1/3 is the first jump" was looking at a scale where 1/3 falls between two ticks.
  // `denominator` lets the model say which fraction the line is in; failing that, a
  // line whose marks are all n/d with one denominator is inferred to be in those.
  const denom = fractionDenominator(op, min, max);
  let step = op.step ?? (denom ? 1 / denom : niceStep(max - min));
  if (!(step > 0) || (max - min) / step > MAX_TICKS) step = denom && (max - min) * denom <= MAX_TICKS ? 1 / denom : niceStep(max - min);
  // Ticks that ARE fractions get labelled as fractions ("1/3"), not as 0.33.
  const tickLabel = (v: number) => (denom ? fractionLabel(v, denom) : fmt(v));
  const axisColor = op.color ?? "black";

  const toPx = (v: number) => x + ((v - min) / (max - min)) * w;
  const ops: DrawOp[] = [];

  // Heading above the line (uses the op's `text` field, if any).
  const heading = (op.text ?? "").trim();
  if (heading) {
    ops.push({ op: "text", id: `${pid}.h`, x, y: y - 42, text: heading, size: "md", color: op.color ?? "purple" });
  }

  // The axis itself.
  ops.push({ op: "line", id: `${pid}.axis`, x, y, x2: x + w, y2: y, color: axisColor });

  // Tick values from the first multiple of step at/after min, up to max.
  const ticks = tickValues(min, max, step, MAX_TICKS);

  // Decimate labels so neighbouring numbers never touch: keep every Nth label.
  const widest = ticks.reduce((m, v) => Math.max(m, measureText(tickLabel(v), FONT_TICK)), 0);
  const pxPerStep = ((toPx(ticks[1] ?? max) - toPx(ticks[0] ?? min)) || w) * (ticks.length > 1 ? 1 : 0.0001);
  const labelEvery = Math.max(1, Math.ceil((widest + 10) / Math.max(Math.abs(pxPerStep), 1)));

  ticks.forEach((v, i) => {
    const px = toPx(v);
    ops.push({ op: "line", id: `${pid}.t${i}`, x: px, y: y - TICK_HALF, x2: px, y2: y + TICK_HALF, color: axisColor });
    if (i % labelEvery === 0) {
      const label = tickLabel(v);
      ops.push({
        op: "text",
        id: `${pid}.l${i}`,
        x: px - measureText(label, FONT_TICK) / 2,
        y: y + LABEL_GAP,
        text: label,
        size: "sm",
        color: axisColor,
      });
    }
  });

  // Marks: a dot ON the line and a label ABOVE it, de-collided left-to-right so
  // two marks that sit close together never overprint each other's labels.
  const marks = (op.marks ?? []).filter((m) => m && m.at >= min && m.at <= max).sort((a, b) => a.at - b.at);
  let lastRight = -Infinity;
  marks.forEach((m, k) => {
    const px = toPx(m.at);
    ops.push({ op: "ellipse", id: `${pid}.d${k}`, x: px - 7, y: y - 7, w: 14, h: 14, color: m.color ?? "red" });
    const text = (m.label ?? tickLabel(m.at)).trim();
    if (!text) return;
    const tw = measureText(text, FONT_TICK);
    let lx = px - tw / 2;
    if (lx < lastRight + 8) lx = lastRight + 8; // push right to clear the previous mark label
    lastRight = lx + tw;
    ops.push({ op: "text", id: `${pid}.m${k}`, x: lx, y: y - MARK_LABEL_GAP, text, size: "sm", color: m.color ?? "red" });
  });

  // Group bounding box (generous), used to dodge pre-existing content as a unit.
  const top = y - (heading ? 48 : marks.length ? MARK_LABEL_GAP + LABEL_H : TICK_HALF + 4);
  const bottom = y + LABEL_GAP + LABEL_H;
  const pad = widest / 2 + 12;
  const bbox = { x: x - pad, y: top, w: w + pad * 2, h: bottom - top };
  const label = `numberline ${fmt(min)}..${fmt(max)}`;
  return { ops, bbox, label };
}

/** Largest denominator worth showing before ticks become a grey smear. */
const MAX_DENOM = 24;
// Tick values are rounded to 6dp by `tickValues`, so 1/3 arrives as 0.333333 and
// 0.333333 * 3 is off by exactly 1e-6. The tolerance has to clear that rounding.
const FRACTION_EPS = 1e-5;

/**
 * The denominator this line should be ticked in, or 0 for an ordinary decimal line.
 *
 * Either the model said so (`denominator: 3`), or every mark on the line is a
 * fraction over the same denominator — which is what a fractions lesson looks like
 * ("mark 1/3 and 2/3") and is unambiguous enough to tick accordingly. An explicit
 * `step` always wins: the model has then already said what it wants.
 */
function fractionDenominator(op: DrawOp, min: number, max: number): number {
  const asked = Math.round(op.denominator ?? 0);
  if (asked > 1 && asked <= MAX_DENOM) return asked;
  if (op.step) return 0; // the model picked a step; respect it
  const marks = (op.marks ?? []).filter((m) => m && Number.isFinite(m.at));
  if (marks.length === 0) return 0;
  // Every mark must be a non-integer n/d for ONE d in range; otherwise it is a
  // normal line that happens to have a mark on it.
  let found = 0;
  for (const m of marks) {
    const d = denominatorOf(m.at);
    if (!d) return 0;
    if (found && d !== found) return 0;
    found = d;
  }
  return found && (max - min) * found <= MAX_TICKS ? found : 0;
}

/** The smallest d in 2..MAX_DENOM with v = n/d exactly, or 0 (incl. for integers). */
function denominatorOf(v: number): number {
  if (Number.isInteger(v)) return 0;
  for (let d = 2; d <= MAX_DENOM; d++) {
    if (Math.abs(v * d - Math.round(v * d)) < FRACTION_EPS) return d;
  }
  return 0;
}

/** 0 -> "0", 1 -> "1", 1/3 -> "1/3", 2/4 -> "1/2" (lowest terms), 4/3 -> "4/3". */
function fractionLabel(v: number, denom: number): string {
  const n = Math.round(v * denom);
  if (Math.abs(v * denom - n) > FRACTION_EPS) return fmt(v);
  if (n % denom === 0) return String(n / denom);
  const g = gcd(Math.abs(n), denom);
  return `${n / g}/${denom / g}`;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a || 1;
}
