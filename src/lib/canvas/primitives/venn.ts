import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `venn` op into 2 or 3 overlapping set circles with labels placed
 * outside the circles (so they never sit on an arc). Circles are drawn as plain
 * outlines (overlaps stay readable); the set colours are used for the labels.
 */

const FONT = 16;

export function expandVenn(op: DrawOp): Expanded {
  const pid = (op.id || "venn").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 680;
  const y = op.y ?? 160;
  const d = Math.max(op.w ?? 190, 80);
  const sets = (op.sets ?? [{ label: "A" }, { label: "B" }]).slice(0, 3);
  const n = Math.max(sets.length, 1);
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 34, text: heading, size: "md", color: "purple" });

  // Circle top-left positions by count.
  const pos: { x: number; y: number }[] =
    n >= 3
      ? [{ x, y }, { x: x + d * 0.6, y }, { x: x + d * 0.3, y: y + d * 0.52 }]
      : n === 2
        ? [{ x, y }, { x: x + d * 0.55, y }]
        : [{ x, y }];

  // Outline circles.
  pos.forEach((p, i) => ops.push({ op: "ellipse", id: `${pid}.c${i}`, x: p.x, y: p.y, w: d, h: d, color: "black" }));

  // Labels outside each circle.
  sets.slice(0, n).forEach((s, i) => {
    const label = (s.label ?? String.fromCharCode(65 + i)).trim();
    if (!label) return;
    const lw = measureText(label, FONT);
    const p = pos[i];
    let lx: number;
    let ly: number;
    if (n >= 3 && i === 2) {
      lx = p.x + d / 2 - lw / 2;
      ly = p.y + d + 8; // bottom circle -> below
    } else if (i === 0) {
      lx = p.x; // left circle -> above-left
      ly = p.y - 10;
    } else {
      lx = p.x + d - lw; // right circle -> above-right
      ly = p.y - 10;
    }
    ops.push({ op: "text", id: `${pid}.l${i}`, x: lx, y: ly, text: label, size: "sm", color: s.color ?? "blue" });
  });

  const spanW = (pos[pos.length - 1].x + d) - x;
  const spanH = (Math.max(...pos.map((p) => p.y)) + d) - y;
  const bbox = { x: x - 20, y: y - (heading ? 44 : 24), w: spanW + 40, h: spanH + (heading ? 60 : 40) };
  return { ops, bbox, label: `venn (${n})` };
}
