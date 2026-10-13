import type { DrawOp } from "../../schema";
import { measureText, TEXT_H, type Expanded } from "./util";

/**
 * Lowers a `labeled` op into callout labels with leader lines for a diagram the
 * model has drawn (cell, flower, apparatus...). Each anchor's label is sent to
 * the left or right margin (whichever side the anchor is on), stacked vertically
 * with guaranteed spacing so labels never overlap, and joined to its anchor by a
 * thin leader line. This is the textbook labelled-figure layout.
 */

const FONT = 16;
const SPACING = TEXT_H + 8;
const MARGIN = 48;

type A = { ax: number; ay: number; text: string; color: DrawOp["color"] };

function placeSide(side: A[], colEdgeX: number, leftSide: boolean, ops: DrawOp[], pid: string, tag: string) {
  if (!side.length) return;
  const sorted = [...side].sort((a, b) => a.ay - b.ay);
  // Stack label y positions downward so none overlaps its neighbour.
  let prev = -Infinity;
  const ys = sorted.map((a) => {
    const y = Math.max(a.ay, prev + SPACING);
    prev = y;
    return y;
  });
  sorted.forEach((a, i) => {
    const ly = ys[i];
    const tw = measureText(a.text, FONT);
    const labelX = leftSide ? colEdgeX - tw : colEdgeX;
    ops.push({ op: "text", id: `${pid}.${tag}t${i}`, x: labelX, y: ly - 9, text: a.text, size: "sm", color: a.color ?? "black" });
    // Leader from the label's inner edge to the anchor, plus a dot on the anchor.
    ops.push({ op: "line", id: `${pid}.${tag}l${i}`, x: colEdgeX, y: ly, x2: a.ax, y2: a.ay, color: "gray" });
    ops.push({ op: "ellipse", id: `${pid}.${tag}d${i}`, x: a.ax - 3, y: a.ay - 3, w: 6, h: 6, color: a.color ?? "black" });
  });
}

export function expandLabeled(op: DrawOp): Expanded {
  const pid = (op.id || "lbl").replace(/[^a-zA-Z0-9_-]/g, "_");
  const pts = (op.points ?? []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.label ?? "").trim());
  const ops: DrawOp[] = [];
  if (!pts.length) return { ops, bbox: { x: op.x ?? 0, y: op.y ?? 0, w: 1, h: 1 }, label: "labels (empty)" };

  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const left: A[] = [];
  const right: A[] = [];
  for (const p of pts) {
    const a: A = { ax: p.x, ay: p.y, text: (p.label ?? "").trim(), color: p.color };
    (p.x < cx ? left : right).push(a);
  }
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const leftEdge = minX - MARGIN;
  const rightEdge = maxX + MARGIN;
  placeSide(left, leftEdge, true, ops, pid, "L");
  placeSide(right, rightEdge, false, ops, pid, "R");

  const heading = (op.text ?? "").trim();
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x: leftEdge, y: minY - 44, text: heading, size: "md", color: "purple" });

  const maxLeftW = left.reduce((m, a) => Math.max(m, measureText(a.text, FONT)), 0);
  const maxRightW = right.reduce((m, a) => Math.max(m, measureText(a.text, FONT)), 0);
  const bbox = {
    x: leftEdge - maxLeftW - 10,
    y: minY - (heading ? 50 : 16),
    w: rightEdge + maxRightW - (leftEdge - maxLeftW) + 20,
    h: maxY - minY + 60,
  };
  return { ops, bbox, label: `labels (${pts.length})` };
}
