import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `punnett` op into a Punnett square: the parent gametes label the top
 * row and left column, and each inner cell shows the combined offspring genotype
 * (alleles ordered dominant-first). The grid and cell sizes are computed so text
 * never overflows. Supports monohybrid (2x2) and larger crosses.
 */

const FONT = 16;
const ROW_H = 34;

/**
 * Combine two gametes allele-by-allele (one locus per character), dominant
 * (uppercase) first within each pair: "t"+"T" -> "Tt", "TR"+"tr" -> "TtRr".
 */
function combine(a: string, b: string): string {
  const L = Math.max(a.length, b.length);
  let out = "";
  for (let i = 0; i < L; i++) {
    const pair = [a[i] ?? "", b[i] ?? ""].filter(Boolean);
    pair.sort((x, y) => {
      const lx = x.toLowerCase();
      const ly = y.toLowerCase();
      if (lx !== ly) return lx < ly ? -1 : 1;
      return x <= y ? -1 : 1; // same letter: uppercase (dominant) first
    });
    out += pair.join("");
  }
  return out;
}

export function expandPunnett(op: DrawOp): Expanded {
  const pid = (op.id || "pun").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 120;
  const y = op.y ?? 180;
  const top = (op.top ?? ["A", "a"]).map((s) => String(s));
  const side = (op.side ?? ["A", "a"]).map((s) => String(s));
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 34, text: heading, size: "md", color: "purple" });

  // Build the grid contents: corner blank, top header, side header, combined cells.
  const ncol = top.length + 1;
  const nrow = side.length + 1;
  const cell = (r: number, c: number): { text: string; header: boolean } => {
    if (r === 0 && c === 0) return { text: "", header: true };
    if (r === 0) return { text: top[c - 1], header: true };
    if (c === 0) return { text: side[r - 1], header: true };
    return { text: combine(side[r - 1], top[c - 1]), header: false };
  };

  // Uniform cell size from the widest content.
  let cw = 44;
  for (let r = 0; r < nrow; r++) for (let c = 0; c < ncol; c++) cw = Math.max(cw, measureText(cell(r, c).text, FONT) + 20);
  const totalW = cw * ncol;
  const totalH = ROW_H * nrow;

  // Tint the header row and column.
  ops.push({ op: "highlight", id: `${pid}.ht`, x, y, w: totalW, h: ROW_H });
  ops.push({ op: "highlight", id: `${pid}.hl`, x, y, w: cw, h: totalH });

  // Grid lines.
  for (let r = 0; r <= nrow; r++) ops.push({ op: "line", id: `${pid}.hr${r}`, x, y: y + r * ROW_H, x2: x + totalW, y2: y + r * ROW_H, color: "black" });
  for (let c = 0; c <= ncol; c++) ops.push({ op: "line", id: `${pid}.vr${c}`, x: x + c * cw, y, x2: x + c * cw, y2: y + totalH, color: "black" });

  // Cell text, centred.
  for (let r = 0; r < nrow; r++) {
    for (let c = 0; c < ncol; c++) {
      const { text, header } = cell(r, c);
      if (!text) continue;
      ops.push({
        op: "text",
        id: `${pid}.c${r}_${c}`,
        x: x + c * cw + cw / 2 - measureText(text, FONT) / 2,
        y: y + r * ROW_H + 8,
        text,
        size: "sm",
        color: header ? "blue" : "black",
      });
    }
  }

  const bbox = { x: x - 6, y: y - (heading ? 40 : 6), w: totalW + 12, h: totalH + (heading ? 46 : 12) };
  return { ops, bbox, label: `punnett ${side.length}x${top.length}` };
}
