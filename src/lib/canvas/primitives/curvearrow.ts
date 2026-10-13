import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `curvearrow` op into a curved arrow: a quadratic Bezier from (x,y) to
 * (x2,y2), bowed sideways by `bow`, sampled as line segments with an arrowhead on
 * the final segment. Use for "becomes" / cyclic flow / electron-shift arrows.
 */

const FONT = 16;

export function expandCurvearrow(op: DrawOp): Expanded {
  const pid = (op.id || "ca").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 0;
  const y = op.y ?? 0;
  const x2 = op.x2 ?? x + 120;
  const y2 = op.y2 ?? y;
  const col = op.color ?? "black";
  const dash = !!op.dash;
  const dx = x2 - x;
  const dy = y2 - y;
  const len = Math.hypot(dx, dy) || 1;
  // Control point: midpoint pushed along the perpendicular by `bow`.
  const bow = op.bow ?? len * 0.3;
  const px = -dy / len;
  const py = dx / len;
  const ctl = { x: (x + x2) / 2 + px * bow, y: (y + y2) / 2 + py * bow };

  const at = (t: number) => {
    const mt = 1 - t;
    return {
      x: mt * mt * x + 2 * mt * t * ctl.x + t * t * x2,
      y: mt * mt * y + 2 * mt * t * ctl.y + t * t * y2,
    };
  };

  const ops: DrawOp[] = [];
  const n = 12;
  for (let i = 0; i < n; i++) {
    const p0 = at(i / n);
    const p1 = at((i + 1) / n);
    // Last segment carries the arrowhead.
    ops.push({ op: i === n - 1 ? "arrow" : "line", id: `${pid}.s${i}`, x: p0.x, y: p0.y, x2: p1.x, y2: p1.y, color: col, dash });
  }

  const text = (op.text ?? "").trim();
  if (text) {
    const mid = at(0.5);
    ops.push({ op: "text", id: `${pid}.l`, x: mid.x - measureText(text, FONT) / 2 + px * 10, y: mid.y - 9 + py * 10, text, size: "sm", color: col });
  }

  const xs = [x, x2, ctl.x];
  const ys = [y, y2, ctl.y];
  const minX = Math.min(...xs) - 16;
  const minY = Math.min(...ys) - 16;
  const bbox = { x: minX, y: minY, w: Math.max(...xs) - minX + 16, h: Math.max(...ys) - minY + 16 };
  return { ops, bbox, label: "curve arrow" };
}
