import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `vector` op into a free-body / force diagram: a central dot (the body)
 * with labelled arrows radiating out, each scaled by its magnitude. Angles are in
 * degrees, 0 = east, counter-clockwise positive. Labels sit just beyond each tip.
 */

const FONT = 16;

export function expandVector(op: DrawOp): Expanded {
  const pid = (op.id || "vec").replace(/[^a-zA-Z0-9_-]/g, "_");
  const cx = op.x ?? 820;
  const cy = op.y ?? 300;
  const rMax = Math.max(op.r ?? 100, 40);
  const vecs = (op.vectors ?? []).filter((v) => v && Number.isFinite(v.angle) && Number.isFinite(v.mag) && v.mag > 0);
  const ops: DrawOp[] = [];

  // The body: a small solid-ish dot (or a box label if text given).
  ops.push({ op: "ellipse", id: `${pid}.body`, x: cx - 7, y: cy - 7, w: 14, h: 14, color: op.color ?? "black" });
  const body = (op.text ?? "").trim();
  if (body) ops.push({ op: "text", id: `${pid}.bl`, x: cx - measureText(body, FONT) / 2, y: cy + 12, text: body, size: "sm", color: "gray" });

  const maxMag = Math.max(...vecs.map((v) => Math.abs(v.mag)), 1);
  vecs.forEach((v, i) => {
    const a = (v.angle * Math.PI) / 180;
    const len = 20 + (Math.abs(v.mag) / maxMag) * (rMax - 20);
    const tipX = cx + Math.cos(a) * len;
    const tipY = cy - Math.sin(a) * len;
    ops.push({ op: "arrow", id: `${pid}.v${i}`, x: cx, y: cy, x2: tipX, y2: tipY, color: v.color ?? "blue" });
    const t = (v.label ?? "").trim();
    if (t) {
      const lx = cx + Math.cos(a) * (len + 14);
      const ly = cy - Math.sin(a) * (len + 14);
      ops.push({ op: "text", id: `${pid}.l${i}`, x: lx - measureText(t, FONT) / 2, y: ly - 9, text: t, size: "sm", color: v.color ?? "blue" });
    }
  });

  const bbox = { x: cx - rMax - 40, y: cy - rMax - 30, w: 2 * (rMax + 40), h: 2 * (rMax + 30) };
  return { ops, bbox, label: `forces (${vecs.length})` };
}
