import type { DrawOp } from "../../schema";
import { CONTENT_LEFT, CONTENT_RIGHT } from "../page";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `table` op into a grid: column widths are computed from the measured
 * cell text, the whole table is kept inside the page's column, and a cell whose
 * text is still too wide is WRAPPED onto more lines (its row grows) rather
 * than drawn across the next cell. The header row is tinted. The model supplies
 * the rows only.
 */

const FONT = 16;
const PADX = 12;
const PADY = 6;
const LINE_H = 22;
/** Widest a single column may be before its text wraps. */
const MAX_COL_W = 480;
const MIN_COL_W = 72;
/** The table never runs past the notes column. */
const MAX_TABLE_W = CONTENT_RIGHT - CONTENT_LEFT;

/** Greedy word wrap; a single word wider than the cell stays whole. */
function wrapCell(text: string, maxW: number): string[] {
  if (measureText(text, FONT) <= maxW) return [text];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measureText(next, FONT) > maxW) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [text];
}

export function expandTable(op: DrawOp): Expanded {
  const pid = (op.id || "tbl").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 80;
  const y = op.y ?? 160;
  const rows = (op.rows ?? []).filter(Array.isArray).map((r) => r.map((c) => String(c ?? "")));
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 34, text: heading, size: "md", color: "purple" });
  if (!rows.length) return { ops, bbox: { x, y, w: 120, h: LINE_H + 2 * PADY }, label: "table (empty)" };

  const ncol = Math.max(...rows.map((r) => r.length));
  // Natural widths, capped per column; then shrink the widest columns until the
  // table fits the page column. Text that no longer fits its cell wraps below.
  const colW: number[] = [];
  for (let c = 0; c < ncol; c++) {
    let wmax = MIN_COL_W;
    for (const r of rows) wmax = Math.max(wmax, measureText(r[c] ?? "", FONT) + PADX * 2);
    colW.push(Math.min(wmax, MAX_COL_W));
  }
  for (let guard = 0; guard < 200 && colW.reduce((a, b) => a + b, 0) > MAX_TABLE_W; guard++) {
    let widest = 0;
    for (let c = 1; c < ncol; c++) if (colW[c] > colW[widest]) widest = c;
    if (colW[widest] <= MIN_COL_W) break;
    colW[widest] = Math.max(MIN_COL_W, colW[widest] - 12);
  }
  const totalW = colW.reduce((a, b) => a + b, 0);

  const cells = rows.map((row) => row.map((t, c) => wrapCell(t.trim(), colW[c] - PADX * 2)));
  const rowH = cells.map((row) => Math.max(1, ...row.map((lines) => lines.length)) * LINE_H + PADY * 2);
  const totalH = rowH.reduce((a, b) => a + b, 0);

  // Tint the header row.
  ops.push({ op: "highlight", id: `${pid}.hdr`, x, y, w: totalW, h: rowH[0], temp: false });
  // Grid lines.
  let gy = y;
  for (let r = 0; r <= rows.length; r++) {
    ops.push({ op: "line", id: `${pid}.hr${r}`, x, y: gy, x2: x + totalW, y2: gy, color: "black" });
    gy += rowH[r] ?? 0;
  }
  let gx = x;
  for (let c = 0; c <= ncol; c++) {
    ops.push({ op: "line", id: `${pid}.vr${c}`, x: gx, y, x2: gx, y2: y + totalH, color: "black" });
    gx += colW[c] ?? 0;
  }
  // Cell text (left-aligned with padding), one text op per wrapped line.
  let rowY = y;
  cells.forEach((row, r) => {
    let colX = x;
    for (let c = 0; c < ncol; c++) {
      const lines = row[c] ?? [];
      lines.forEach((t, li) => {
        if (t) ops.push({ op: "text", id: `${pid}.c${r}_${c}_${li}`, x: colX + PADX, y: rowY + PADY + li * LINE_H, text: t, size: "sm", color: "black" });
      });
      colX += colW[c] ?? 0;
    }
    rowY += rowH[r];
  });

  const bbox = { x: x - 6, y: y - (heading ? 40 : 6), w: totalW + 12, h: totalH + (heading ? 46 : 12) };
  return { ops, bbox, label: `table ${rows.length}x${ncol}` };
}
