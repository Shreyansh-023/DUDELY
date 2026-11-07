import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a free-standing `angle` op (part of a sketch, with its own vertex and
 * ray directions) into two rays from the vertex, a small arc between them, and
 * the measure label on the bisector. Angles are in degrees, 0 = east and
 * counter-clockwise positive (screen y grows down, so we negate the sine).
 *
 * An angle ON A FIGURE is not drawn by this: it names the vertex (`at: "A"`)
 * and lib/canvas/anchors draws the arc on the committed corner, without rays.
 */

const FONT = 16;

export function expandAngle(op: DrawOp): Expanded {
  const pid = (op.id || "ang").replace(/[^a-zA-Z0-9_-]/g, "_");
  const vx = op.x ?? 760;
  const vy = op.y ?? 300;
  const r = Math.max(op.r ?? 120, 40);
  const col = op.color ?? "black";
  const a1 = ((op.a1 ?? 0) * Math.PI) / 180;
  const a2 = ((op.a2 ?? 60) * Math.PI) / 180;
  const dir = (a: number) => ({ x: Math.cos(a), y: -Math.sin(a) });
  const ops: DrawOp[] = [];
  const xs: number[] = [vx];
  const ys: number[] = [vy];
  const note = (x: number, y: number) => {
    xs.push(x);
    ys.push(y);
  };

  const d1 = dir(a1);
  const d2 = dir(a2);
  ops.push({ op: "line", id: `${pid}.r1`, x: vx, y: vy, x2: vx + d1.x * r, y2: vy + d1.y * r, color: col });
  ops.push({ op: "line", id: `${pid}.r2`, x: vx, y: vy, x2: vx + d2.x * r, y2: vy + d2.y * r, color: col });
  note(vx + d1.x * r, vy + d1.y * r);
  note(vx + d2.x * r, vy + d2.y * r);

  // Arc between the rays, sampled as short segments.
  const ra = Math.min(r * 0.32, 34);
  const steps = 10;
  for (let i = 0; i < steps; i++) {
    const t0 = a1 + ((a2 - a1) * i) / steps;
    const t1 = a1 + ((a2 - a1) * (i + 1)) / steps;
    ops.push({
      op: "line",
      id: `${pid}.a${i}`,
      x: vx + Math.cos(t0) * ra,
      y: vy - Math.sin(t0) * ra,
      x2: vx + Math.cos(t1) * ra,
      y2: vy - Math.sin(t1) * ra,
      color: col,
    });
  }

  // Measure label on the bisector, past the arc — never on top of it.
  const mid = (a1 + a2) / 2;
  const deg = Math.round((Math.abs((op.a2 ?? 60) - (op.a1 ?? 0)) + 360) % 360);
  const text = (op.text ?? `${deg}°`).trim();
  if (text) {
    const w = measureText(text, FONT);
    const h = 20;
    const bis = { x: Math.cos(mid), y: -Math.sin(mid) };
    const half = Math.abs(bis.x) * (w / 2) + Math.abs(bis.y) * (h / 2);
    const lr = Math.max(r * 0.5, ra + 10 + half);
    const lx = vx + bis.x * lr - w / 2;
    const ly = vy + bis.y * lr - h / 2;
    ops.push({ op: "text", id: `${pid}.lbl`, x: lx, y: ly, text, size: "sm", color: col });
    note(lx, ly);
    note(lx + w, ly + h);
  }

  // The real extent — not a 2r square: a figure plus its angle mark used to
  // report itself far taller than it drew and was spilled to a page of its own.
  const x = Math.min(...xs) - 6;
  const y = Math.min(...ys) - 6;
  const bbox = { x, y, w: Math.max(...xs) - x + 6, h: Math.max(...ys) - y + 6 };
  return { ops, bbox, label: `angle ${deg}°` };
}
