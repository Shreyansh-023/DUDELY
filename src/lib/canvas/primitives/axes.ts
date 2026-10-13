import type { DrawOp } from "../../schema";
import { fmt, measureText, niceStep, TEXT_H, tickValues, type Expanded } from "./util";

/**
 * Lowers a high-level `axes` op into a Cartesian coordinate plane: two axis
 * arrows through the origin, evenly-spaced ticks with numbers in reserved bands
 * (x below, y left), decimated per-axis by measured size so they never collide,
 * optional axis titles, and plotted points as dots with offset labels. The model
 * supplies ranges and points only — never pixel coordinates for ticks.
 */

const FONT = 16;
const TICK = 4; // tick half-length
const MAX = 60;

export function expandAxes(op: DrawOp): Expanded {
  const pid = (op.id || "ax").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 680;
  const y = op.y ?? 120;
  const w = Math.max(op.w ?? 440, 160);
  const h = Math.max(op.h ?? 340, 120);
  let xmin = op.xmin ?? -5;
  let xmax = op.xmax ?? 5;
  let ymin = op.ymin ?? -5;
  let ymax = op.ymax ?? 5;
  if (!(xmax > xmin)) {
    xmin = -5;
    xmax = 5;
  }
  if (!(ymax > ymin)) {
    ymin = -5;
    ymax = 5;
  }
  let xstep = op.xstep ?? niceStep(xmax - xmin);
  let ystep = op.ystep ?? niceStep(ymax - ymin);
  if (!(xstep > 0) || (xmax - xmin) / xstep > MAX) xstep = niceStep(xmax - xmin);
  if (!(ystep > 0) || (ymax - ymin) / ystep > MAX) ystep = niceStep(ymax - ymin);
  const col = op.color ?? "black";

  const toX = (v: number) => x + ((v - xmin) / (xmax - xmin)) * w;
  const toY = (v: number) => y + h - ((v - ymin) / (ymax - ymin)) * h;
  const ox = Math.min(Math.max(toX(0), x), x + w); // origin clamped into the box
  const oy = Math.min(Math.max(toY(0), y), y + h);

  const ops: DrawOp[] = [];
  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 34, text: heading, size: "md", color: op.color ?? "purple" });

  // Axes (arrows pointing in the +x / +y directions).
  ops.push({ op: "arrow", id: `${pid}.ax`, x, y: oy, x2: x + w, y2: oy, color: col });
  ops.push({ op: "arrow", id: `${pid}.ay`, x: ox, y: y + h, x2: ox, y2: y, color: col });
  if (op.xlabel) ops.push({ op: "text", id: `${pid}.xl`, x: x + w + 6, y: oy - 8, text: op.xlabel, size: "sm", color: col });
  if (op.ylabel) ops.push({ op: "text", id: `${pid}.yl`, x: ox + 8, y: y - 8, text: op.ylabel, size: "sm", color: col });

  // X ticks + numbers below the axis, decimated by width.
  const xt = tickValues(xmin, xmax, xstep, MAX);
  const xWidest = xt.reduce((m, v) => Math.max(m, measureText(fmt(v), FONT)), 0);
  const xSpacing = Math.abs(toX(xt[1] ?? xmax) - toX(xt[0] ?? xmin)) || w;
  const xEvery = Math.max(1, Math.ceil((xWidest + 8) / xSpacing));
  xt.forEach((v, i) => {
    if (Math.abs(v) < 1e-9) return; // origin handled separately
    const px = toX(v);
    ops.push({ op: "line", id: `${pid}.xt${i}`, x: px, y: oy - TICK, x2: px, y2: oy + TICK, color: col });
    if (i % xEvery === 0) {
      const t = fmt(v);
      ops.push({ op: "text", id: `${pid}.xn${i}`, x: px - measureText(t, FONT) / 2, y: oy + 8, text: t, size: "sm", color: col });
    }
  });

  // Y ticks + numbers left of the axis, decimated by height.
  const yt = tickValues(ymin, ymax, ystep, MAX);
  const ySpacing = Math.abs(toY(yt[1] ?? ymax) - toY(yt[0] ?? ymin)) || h;
  const yEvery = Math.max(1, Math.ceil((TEXT_H + 4) / ySpacing));
  yt.forEach((v, i) => {
    if (Math.abs(v) < 1e-9) return;
    const py = toY(v);
    ops.push({ op: "line", id: `${pid}.yt${i}`, x: ox - TICK, y: py, x2: ox + TICK, y2: py, color: col });
    if (i % yEvery === 0) {
      const t = fmt(v);
      ops.push({ op: "text", id: `${pid}.yn${i}`, x: ox - 8 - measureText(t, FONT), y: py - TEXT_H / 2, text: t, size: "sm", color: col });
    }
  });

  // Origin "0" just down-left of the origin.
  ops.push({ op: "text", id: `${pid}.o`, x: ox - 14, y: oy + 6, text: "0", size: "sm", color: col });

  // Curves: each a polyline of sampled data points, connected by segments and
  // clipped to the plot box. The model samples the function; we map and draw.
  (op.curves ?? []).forEach((c, ci) => {
    const pts = (c.points ?? [])
      .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ px: toX(p.x), py: toY(p.y) }))
      // keep points whose pixel position is within (a small margin of) the box
      .filter((p) => p.px >= x - 2 && p.px <= x + w + 2 && p.py >= y - 2 && p.py <= y + h + 2);
    const color = c.color ?? "red";
    for (let i = 1; i < pts.length; i++) {
      ops.push({
        op: "line",
        id: `${pid}.c${ci}_${i}`,
        x: pts[i - 1].px,
        y: pts[i - 1].py,
        x2: pts[i].px,
        y2: pts[i].py,
        color,
      });
    }
    const last = pts[pts.length - 1];
    if (last && c.label) ops.push({ op: "text", id: `${pid}.cl${ci}`, x: last.px + 6, y: last.py - 18, text: c.label, size: "sm", color });
  });

  // Plotted points: a dot and a label offset up-right into open space.
  (op.points ?? []).forEach((p, k) => {
    if (p.x < xmin || p.x > xmax || p.y < ymin || p.y > ymax) return;
    const px = toX(p.x);
    const py = toY(p.y);
    ops.push({ op: "ellipse", id: `${pid}.p${k}`, x: px - 5, y: py - 5, w: 10, h: 10, color: p.color ?? "blue" });
    const t = (p.label ?? `(${fmt(p.x)}, ${fmt(p.y)})`).trim();
    if (t) ops.push({ op: "text", id: `${pid}.pl${k}`, x: px + 8, y: py - 22, text: t, size: "sm", color: p.color ?? "blue" });
  });

  const bbox = { x: x - 48, y: y - (heading ? 40 : 12), w: w + 90, h: h + (heading ? 70 : 42) };
  return { ops, bbox, label: `axes x[${fmt(xmin)},${fmt(xmax)}] y[${fmt(ymin)},${fmt(ymax)}]` };
}
