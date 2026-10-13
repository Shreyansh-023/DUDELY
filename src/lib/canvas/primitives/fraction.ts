import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a high-level `fraction` op into a bar divided into equal parts, with the
 * shaded count filled (hand-drawn hachure) and a "shaded/parts" caption. The
 * model gives the denominator and numerator only; the renderer guarantees equal,
 * non-overlapping cells. (A bar model is used rather than a pie because the
 * hand-drawn primitives can shade a rectangle cleanly but not a circle sector.)
 */

const FONT = 16;

export function expandFraction(op: DrawOp): Expanded {
  const pid = (op.id || "fr").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 80;
  const y = op.y ?? 200;
  const parts = Math.max(1, Math.min(20, Math.round(op.parts ?? 2)));
  const shaded = Math.max(0, Math.min(parts, Math.round(op.shaded ?? 0)));
  // Keep each cell wide enough that the low-level rect's minimum size never distorts it.
  const w = Math.max(op.w ?? 360, parts * 46);
  const hh = Math.max(op.h ?? 70, 40);
  const col = op.color ?? "blue";
  const cw = w / parts;
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 34, text: heading, size: "md", color: "purple" });

  // Shaded cells first (filled), then the outline and the dividers on top.
  for (let i = 0; i < shaded; i++) {
    ops.push({ op: "rect", id: `${pid}.s${i}`, x: x + i * cw, y, w: cw, h: hh, color: col });
  }
  ops.push({ op: "rect", id: `${pid}.box`, x, y, w, h: hh, color: "black" });
  for (let i = 1; i < parts; i++) {
    ops.push({ op: "line", id: `${pid}.d${i}`, x: x + i * cw, y, x2: x + i * cw, y2: y + hh, color: "black" });
  }

  // Caption below, centred.
  const caption = `${shaded}/${parts}`;
  ops.push({ op: "text", id: `${pid}.cap`, x: x + w / 2 - measureText(caption, FONT) / 2, y: y + hh + 10, text: caption, size: "md", color: "green" });

  const bbox = { x: x - 10, y: y - (heading ? 40 : 10), w: w + 20, h: hh + (heading ? 80 : 50) };
  return { ops, bbox, label: `fraction ${shaded}/${parts}` };
}
