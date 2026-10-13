import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers an `angle` op into two rays from a vertex, a small arc between them, and
 * the measure label on the arc's bisector. Angles are in degrees, 0 = east and
 * counter-clockwise positive (screen y grows down, so we negate the sine).
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

  const d1 = dir(a1);
  const d2 = dir(a2);
  ops.push({ op: "line", id: `${pid}.r1`, x: vx, y: vy, x2: vx + d1.x * r, y2: vy + d1.y * r, color: col });
  ops.push({ op: "line", id: `${pid}.r2`, x: vx, y: vy, x2: vx + d2.x * r, y2: vy + d2.y * r, color: col });

  // Arc between the rays, sampled as short segments at ~0.32r.
  const ra = r * 0.32;
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

  // Measure label on the bisector.
  const mid = (a1 + a2) / 2;
  const deg = Math.round((Math.abs((op.a2 ?? 60) - (op.a1 ?? 0)) + 360) % 360);
  const text = (op.text ?? `${deg}°`).trim();
  if (text) {
    const lr = r * 0.5;
    ops.push({
      op: "text",
      id: `${pid}.lbl`,
      x: vx + Math.cos(mid) * lr - measureText(text, FONT) / 2,
      y: vy - Math.sin(mid) * lr - 9,
      text,
      size: "sm",
      color: col,
    });
  }

  const bbox = { x: vx - r - 20, y: vy - r - 20, w: 2 * r + 40, h: 2 * r + 40 };
  return { ops, bbox, label: `angle ${deg}°` };
}
