import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `circuit` op into either a SERIES loop (components spaced along the
 * top edge) or, when `branches` is given, a PARALLEL circuit (each branch a
 * horizontal rung between two vertical buses, with a common cell on the bottom).
 * The wire is drawn only in the gaps between symbols, so it never runs through
 * one. Supports cell, battery, resistor, bulb, switch, ammeter, voltmeter, wire.
 */

const FONT = 16;
const HALF = 26; // half-width reserved for each component on the wire

type Comp = { type: string; label?: string | null };

function symbol(type: string, xc: number, wy: number, pid: string, i: number): DrawOp[] {
  const t = type.toLowerCase();
  const o: DrawOp[] = [];
  const line = (sx: number, sy: number, ex: number, ey: number, k: string) =>
    o.push({ op: "line", id: `${pid}.s${i}_${k}`, x: sx, y: sy, x2: ex, y2: ey, color: "black" });
  if (t === "cell") {
    line(xc - 5, wy - 14, xc - 5, wy + 14, "lg");
    line(xc + 5, wy - 7, xc + 5, wy + 7, "sh");
  } else if (t === "battery") {
    [-12, 2].forEach((dx, j) => {
      line(xc + dx, wy - 14, xc + dx, wy + 14, `lg${j}`);
      line(xc + dx + 7, wy - 7, xc + dx + 7, wy + 7, `sh${j}`);
    });
  } else if (t === "resistor") {
    o.push({ op: "rect", id: `${pid}.s${i}_r`, x: xc - 22, y: wy - 10, w: 44, h: 20, color: "black" });
  } else if (t === "bulb") {
    o.push({ op: "ellipse", id: `${pid}.s${i}_c`, x: xc - 18, y: wy - 18, w: 36, h: 36, color: "black" });
    line(xc - 12, wy - 12, xc + 12, wy + 12, "x1");
    line(xc - 12, wy + 12, xc + 12, wy - 12, "x2");
  } else if (t === "switch") {
    line(xc - 16, wy, xc + 12, wy - 16, "sw");
    o.push({ op: "ellipse", id: `${pid}.s${i}_d1`, x: xc - 18, y: wy - 2, w: 5, h: 5, color: "black" });
    o.push({ op: "ellipse", id: `${pid}.s${i}_d2`, x: xc + 13, y: wy - 2, w: 5, h: 5, color: "black" });
  } else if (t === "ammeter" || t === "voltmeter") {
    o.push({ op: "ellipse", id: `${pid}.s${i}_m`, x: xc - 18, y: wy - 18, w: 36, h: 36, color: "black" });
    const letter = t === "ammeter" ? "A" : "V";
    o.push({ op: "text", id: `${pid}.s${i}_mt`, x: xc - measureText(letter, FONT) / 2, y: wy - 9, text: letter, size: "sm", color: "black" });
  } else if (t === "junction" || t === "node") {
    o.push({ op: "ellipse", id: `${pid}.s${i}_j`, x: xc - 4, y: wy - 4, w: 8, h: 8, color: "black" });
  }
  return o;
}

/** Place components along a horizontal wire [xs, xe] at height wy; wire fills the gaps only. */
function placeRow(comps: Comp[], xs: number, xe: number, wy: number, labelDy: number, pid: string, key: string): DrawOp[] {
  const ops: DrawOp[] = [];
  const n = Math.max(comps.length, 1);
  const slot = (xe - xs) / n;
  const centres = comps.map((_, i) => xs + slot * (i + 0.5));
  let cursor = xs;
  const wire = (sx: number, ex: number, k: string) => {
    if (ex - sx > 1) ops.push({ op: "line", id: `${pid}.w${key}${k}`, x: sx, y: wy, x2: ex, y2: wy, color: "black" });
  };
  centres.forEach((cxc, i) => {
    wire(cursor, cxc - HALF, `${i}`);
    cursor = cxc + HALF;
  });
  wire(cursor, xe, "end");
  comps.forEach((c, i) => {
    ops.push(...symbol(c.type, centres[i], wy, `${pid}.${key}`, i));
    const t = (c.label ?? "").trim();
    if (t) ops.push({ op: "text", id: `${pid}.${key}cl${i}`, x: centres[i] - measureText(t, FONT) / 2, y: wy + labelDy, text: t, size: "sm", color: "black" });
  });
  return ops;
}

export function expandCircuit(op: DrawOp): Expanded {
  const pid = (op.id || "ckt").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 680;
  const y = op.y ?? 160;
  const branches = (op.branches ?? []).map((b) => (b ?? []).filter((c) => c && c.type)).filter((b) => b.length);
  const ops: DrawOp[] = [];
  const heading = (op.text ?? "").trim();

  if (branches.length) {
    // ---- Parallel: rungs between two buses, common cell on the bottom ----
    const maxComp = Math.max(...branches.map((b) => b.length), 1);
    const w = Math.max(op.w ?? 460, maxComp * 90);
    const h = Math.max(op.h ?? 60 * branches.length + 40, 120);
    if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 34, text: heading, size: "md", color: "purple" });
    branches.forEach((b, j) => {
      const wy = y + (h / (branches.length + 1)) * (j + 1);
      ops.push(...placeRow(b, x, x + w, wy, -24, pid, `r${j}`));
    });
    // Buses down each side, then down to the source wire.
    const srcY = y + h + 44;
    ops.push({ op: "line", id: `${pid}.busL`, x, y, x2: x, y2: srcY, color: "black" });
    ops.push({ op: "line", id: `${pid}.busR`, x: x + w, y, x2: x + w, y2: srcY, color: "black" });
    ops.push(...placeRow([{ type: "cell", label: "cell" }], x, x + w, srcY, 26, pid, "src"));
    const bbox = { x: x - 10, y: y - (heading ? 44 : 14), w: w + 20, h: srcY - y + (heading ? 70 : 54) };
    return { ops, bbox, label: `circuit parallel (${branches.length})` };
  }

  // ---- Series: components along the top edge of a rectangular loop ----
  const comps = (op.components ?? []).filter((c) => c && c.type).slice(0, 8);
  const n = Math.max(comps.length, 1);
  const w = Math.max(op.w ?? 460, n * 80);
  const h = Math.max(op.h ?? 220, 120);
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 34, text: heading, size: "md", color: "purple" });
  ops.push(...placeRow(comps, x, x + w, y, 26, pid, "t"));
  ops.push({ op: "line", id: `${pid}.wl`, x, y, x2: x, y2: y + h, color: "black" });
  ops.push({ op: "line", id: `${pid}.wr`, x: x + w, y, x2: x + w, y2: y + h, color: "black" });
  ops.push({ op: "line", id: `${pid}.wb`, x, y: y + h, x2: x + w, y2: y + h, color: "black" });
  const bbox = { x: x - 10, y: y - (heading ? 44 : 24), w: w + 20, h: h + (heading ? 58 : 40) };
  return { ops, bbox, label: `circuit (${n})` };
}
