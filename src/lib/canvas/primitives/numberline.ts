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
  let step = op.step ?? niceStep(max - min);
  if (!(step > 0) || (max - min) / step > MAX_TICKS) step = niceStep(max - min);
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
  const widest = ticks.reduce((m, v) => Math.max(m, measureText(fmt(v), FONT_TICK)), 0);
  const pxPerStep = ((toPx(ticks[1] ?? max) - toPx(ticks[0] ?? min)) || w) * (ticks.length > 1 ? 1 : 0.0001);
  const labelEvery = Math.max(1, Math.ceil((widest + 10) / Math.max(Math.abs(pxPerStep), 1)));

  ticks.forEach((v, i) => {
    const px = toPx(v);
    ops.push({ op: "line", id: `${pid}.t${i}`, x: px, y: y - TICK_HALF, x2: px, y2: y + TICK_HALF, color: axisColor });
    if (i % labelEvery === 0) {
      const label = fmt(v);
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
    const text = (m.label ?? fmt(m.at)).trim();
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
