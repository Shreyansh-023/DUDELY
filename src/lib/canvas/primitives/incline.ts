import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers an `incline` op into an inclined-plane diagram: a right-triangle ramp
 * (base, vertical rise, hypotenuse = the slope), the slope angle marked at the
 * base vertex, and a block sitting ON the slope (drawn as a parallelogram aligned
 * to the surface). Use for friction / forces-on-a-slope problems.
 */

const FONT = 16;

export function expandIncline(op: DrawOp): Expanded {
  const pid = (op.id || "inc").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 700; // bottom-left (base + slope vertex)
  const y = op.y ?? 360; // ground level
  const w = Math.max(op.w ?? 240, 80);
  const deg = Math.max(Math.min(op.angle ?? 30, 80), 5);
  const theta = (deg * Math.PI) / 180;
  const h = w * Math.tan(theta); // rise at the right end
  const col = op.color ?? "black";
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - h - 40, text: heading, size: "md", color: "purple" });

  // Triangle: base, vertical rise, hypotenuse (the slope from bottom-left up to top-right).
  const topR = { x: x + w, y: y - h };
  ops.push({ op: "line", id: `${pid}.base`, x, y, x2: x + w, y2: y, color: col });
  ops.push({ op: "line", id: `${pid}.rise`, x: x + w, y, x2: topR.x, y2: topR.y, color: col });
  ops.push({ op: "line", id: `${pid}.slope`, x, y, x2: topR.x, y2: topR.y, color: col });

  // Angle arc at the base vertex (between base and slope).
  const ra = Math.min(w * 0.28, 46);
  const n = 8;
  for (let i = 0; i < n; i++) {
    const t0 = (-theta * i) / n;
    const t1 = (-theta * (i + 1)) / n;
    ops.push({ op: "line", id: `${pid}.arc${i}`, x: x + ra * Math.cos(t0), y: y + ra * Math.sin(t0), x2: x + ra * Math.cos(t1), y2: y + ra * Math.sin(t1), color: col });
  }
  ops.push({ op: "text", id: `${pid}.th`, x: x + ra + 4, y: y - ra * Math.sin(theta) / 2 - 9, text: `${deg}°`, size: "sm", color: col });

  // Block on the slope (parallelogram aligned to the surface), at the midpoint.
  const L = Math.hypot(w, h);
  const u = { x: w / L, y: -h / L }; // up-slope direction
  const nrm = { x: -h / L, y: -w / L }; // outward normal (up-left, off the surface)
  const M = { x: x + w * 0.5, y: y - h * 0.5 };
  const s = 30;
  const c1 = { x: M.x - u.x * (s / 2), y: M.y - u.y * (s / 2) };
  const c2 = { x: M.x + u.x * (s / 2), y: M.y + u.y * (s / 2) };
  const c3 = { x: c2.x + nrm.x * s, y: c2.y + nrm.y * s };
  const c4 = { x: c1.x + nrm.x * s, y: c1.y + nrm.y * s };
  ops.push({ op: "line", id: `${pid}.b1`, x: c1.x, y: c1.y, x2: c2.x, y2: c2.y, color: "blue" });
  ops.push({ op: "line", id: `${pid}.b2`, x: c2.x, y: c2.y, x2: c3.x, y2: c3.y, color: "blue" });
  ops.push({ op: "line", id: `${pid}.b3`, x: c3.x, y: c3.y, x2: c4.x, y2: c4.y, color: "blue" });
  ops.push({ op: "line", id: `${pid}.b4`, x: c4.x, y: c4.y, x2: c1.x, y2: c1.y, color: "blue" });

  const bbox = { x: x - 10, y: y - h - (heading ? 46 : 40), w: w + 30, h: h + (heading ? 60 : 54) };
  return { ops, bbox, label: `incline ${deg}°` };
}
