import type { ColorName, DrawOp } from "../../schema";
import { fmt, measureText, niceStep, TEXT_H, tickValues, type Expanded } from "./util";

/**
 * Lowers a high-level `bars` op into a bar chart: a baseline and y-axis, evenly
 * spaced bars scaled to the data, a value label centred above each bar, and a
 * category label centred below it (truncated to its slot so neighbours never
 * collide). The model supplies the data only; all geometry is computed here.
 */

const FONT = 16;
const PALETTE: ColorName[] = ["blue", "green", "orange", "purple", "red", "gray"];

/** Shorten text with an ellipsis until it fits maxWidth. */
function fit(text: string, maxWidth: number): string {
  if (measureText(text, FONT) <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && measureText(s + "…", FONT) > maxWidth) s = s.slice(0, -1);
  return s + "…";
}

export function expandBars(op: DrawOp): Expanded {
  const pid = (op.id || "bar").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 680;
  const y = op.y ?? 140;
  const w = Math.max(op.w ?? 440, 160);
  const h = Math.max(op.h ?? 300, 120);
  const col = op.color ?? "black";
  const data = (op.data ?? []).slice(0, 24).filter((d) => d && Number.isFinite(d.value));
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 34, text: heading, size: "md", color: op.color ?? "purple" });

  // Axes: y-axis up the left, baseline along the bottom.
  const baseY = y + h;
  ops.push({ op: "line", id: `${pid}.ay`, x, y, x2: x, y2: baseY, color: col });
  ops.push({ op: "line", id: `${pid}.ax`, x, y: baseY, x2: x + w, y2: baseY, color: col });

  if (!data.length) return { ops, bbox: { x: x - 40, y: y - 40, w: w + 60, h: h + 70 }, label: "bars (empty)" };

  const maxV = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const scale = h / maxV;

  // Light y-axis scale so values are readable.
  const ystep = niceStep(maxV);
  const yt = tickValues(0, maxV, ystep, 40);
  const ySpacing = Math.abs((yt[1] ?? maxV) - (yt[0] ?? 0)) * scale || h;
  const yEvery = Math.max(1, Math.ceil((TEXT_H + 4) / ySpacing));
  yt.forEach((v, i) => {
    const py = baseY - v * scale;
    ops.push({ op: "line", id: `${pid}.yt${i}`, x: x - 4, y: py, x2: x, y2: py, color: col });
    if (i % yEvery === 0 && v > 0) {
      const t = fmt(v);
      ops.push({ op: "text", id: `${pid}.yn${i}`, x: x - 8 - measureText(t, FONT), y: py - TEXT_H / 2, text: t, size: "sm", color: col });
    }
  });

  const slot = w / data.length;
  const barW = Math.min(slot * 0.6, 90);
  data.forEach((d, i) => {
    const cx = x + slot * i + slot / 2;
    const bh = Math.max(Math.abs(d.value) * scale, 1);
    const bx = cx - barW / 2;
    const by = baseY - bh;
    ops.push({ op: "rect", id: `${pid}.b${i}`, x: bx, y: by, w: barW, h: bh, color: d.color ?? PALETTE[i % PALETTE.length] });
    const val = fmt(d.value);
    ops.push({ op: "text", id: `${pid}.v${i}`, x: cx - measureText(val, FONT) / 2, y: by - 22, text: val, size: "sm", color: col });
    const cat = (d.label ?? "").trim();
    if (cat) {
      const t = fit(cat, slot - 6);
      ops.push({ op: "text", id: `${pid}.c${i}`, x: cx - measureText(t, FONT) / 2, y: baseY + 8, text: t, size: "sm", color: col });
    }
  });

  const bbox = { x: x - 48, y: y - (heading ? 40 : 24), w: w + 70, h: h + (heading ? 74 : 60) };
  return { ops, bbox, label: `bars (${data.length})` };
}
