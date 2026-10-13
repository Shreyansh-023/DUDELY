import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `table` op into a grid: column widths are computed from the measured
 * cell text so nothing is clipped or overlaps, the header row is tinted, and all
 * cell text is placed with padding. The model supplies the rows only.
 */

const FONT = 16;
const PADX = 12;
const ROW_H = 30;

export function expandTable(op: DrawOp): Expanded {
  const pid = (op.id || "tbl").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 80;
  const y = op.y ?? 160;
  const rows = (op.rows ?? []).filter(Array.isArray).map((r) => r.map((c) => String(c ?? "")));
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 34, text: heading, size: "md", color: "purple" });
  if (!rows.length) return { ops, bbox: { x, y, w: 120, h: ROW_H }, label: "table (empty)" };

  const ncol = Math.max(...rows.map((r) => r.length));
  const colW: number[] = [];
  for (let c = 0; c < ncol; c++) {
    let wmax = 40;
    for (const r of rows) wmax = Math.max(wmax, measureText(r[c] ?? "", FONT) + PADX * 2);
    colW.push(Math.min(wmax, 240));
  }
  const totalW = colW.reduce((a, b) => a + b, 0);
  const totalH = rows.length * ROW_H;

  // Tint the header row.
  ops.push({ op: "highlight", id: `${pid}.hdr`, x, y, w: totalW, h: ROW_H });
  // Grid lines.
  let gy = y;
  for (let r = 0; r <= rows.length; r++) {
    ops.push({ op: "line", id: `${pid}.hr${r}`, x, y: gy, x2: x + totalW, y2: gy, color: "black" });
    gy += ROW_H;
  }
  let gx = x;
  for (let c = 0; c <= ncol; c++) {
    ops.push({ op: "line", id: `${pid}.vr${c}`, x: gx, y, x2: gx, y2: y + totalH, color: "black" });
    gx += colW[c] ?? 0;
  }
  // Cell text (left-aligned with padding).
  rows.forEach((row, r) => {
    let colX = x;
    for (let c = 0; c < ncol; c++) {
      const t = (row[c] ?? "").trim();
      if (t) ops.push({ op: "text", id: `${pid}.c${r}_${c}`, x: colX + PADX, y: y + r * ROW_H + 6, text: t, size: "sm", color: "black" });
      colX += colW[c] ?? 0;
    }
  });

  const bbox = { x: x - 6, y: y - (heading ? 40 : 6), w: totalW + 12, h: totalH + (heading ? 46 : 12) };
  return { ops, bbox, label: `table ${rows.length}x${ncol}` };
}
