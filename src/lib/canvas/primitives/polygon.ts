import type { DrawOp } from "../../schema";
import { boundsOf, measureText, TEXT_H, type Expanded } from "./util";

/**
 * Lowers a high-level `polygon` op into a closed shape whose vertices the model
 * supplies, but whose LABELS the renderer places: each vertex label is pushed
 * OUTSIDE the shape (away from the centroid) so it never sits on an edge, side
 * labels go just outside each edge midpoint, and 90-degree corners get a small
 * right-angle square automatically. This is what keeps triangle/Pythagoras
 * diagrams clean — the model stops hand-placing labels on top of the figure.
 */

const FONT = 16;

type P = { x: number; y: number };
const norm = (v: P): P => {
  const d = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / d, y: v.y / d };
};

export function expandPolygon(op: DrawOp): Expanded {
  const pid = (op.id || "poly").replace(/[^a-zA-Z0-9_-]/g, "_");
  const pts = (op.points ?? []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const col = op.color ?? "black";
  if (pts.length < 2) {
    return { ops: [], bbox: { x: op.x ?? 0, y: op.y ?? 0, w: 1, h: 1 }, label: "polygon (empty)" };
  }
  const closed = op.closed ?? true;
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p.x, 0) / n;
  const cy = pts.reduce((s, p) => s + p.y, 0) / n;
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) {
    const b = boundsOf(pts);
    ops.push({ op: "text", id: `${pid}.h`, x: b.x, y: b.y - 40, text: heading, size: "md", color: "purple" });
  }

  // Edges.
  const edgeCount = closed ? n : n - 1;
  for (let i = 0; i < edgeCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    ops.push({ op: "line", id: `${pid}.e${i}`, x: a.x, y: a.y, x2: b.x, y2: b.y, color: col });
  }

  // Side labels: just outside each edge midpoint (perpendicular, away from centroid).
  const sides = op.sides ?? [];
  for (let i = 0; i < edgeCount; i++) {
    const t = (sides[i] ?? "").trim();
    if (!t) continue;
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const out = norm({ x: mx - cx, y: my - cy });
    ops.push({
      op: "text",
      id: `${pid}.s${i}`,
      x: mx + out.x * 18 - measureText(t, FONT) / 2,
      y: my + out.y * 18 - TEXT_H / 2,
      text: t,
      size: "sm",
      color: "blue",
    });
  }

  // Vertex labels: pushed outward from the centroid so they clear the edges.
  pts.forEach((p, i) => {
    const t = (p.label ?? "").trim();
    if (!t) return;
    let dir = norm({ x: p.x - cx, y: p.y - cy });
    if (!Number.isFinite(dir.x) || (dir.x === 0 && dir.y === 0)) dir = { x: 0, y: -1 };
    ops.push({
      op: "text",
      id: `${pid}.v${i}`,
      x: p.x + dir.x * 22 - measureText(t, FONT) / 2,
      y: p.y + dir.y * 22 - TEXT_H / 2,
      text: t,
      size: "sm",
      color: p.color ?? "black",
    });
  });

  // Right-angle marks at ~90-degree corners (closed shapes, or interior vertices).
  const corners = closed ? n : n; // check every vertex that has two neighbours
  for (let i = 0; i < corners; i++) {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    if (!closed && (i === 0 || i === n - 1)) continue; // endpoints have one edge
    const v = pts[i];
    const ua = norm({ x: prev.x - v.x, y: prev.y - v.y });
    const ub = norm({ x: next.x - v.x, y: next.y - v.y });
    const cos = ua.x * ub.x + ua.y * ub.y;
    if (Math.abs(cos) > 0.09) continue; // not a right angle
    const s = 12;
    const c1 = { x: v.x + ua.x * s, y: v.y + ua.y * s };
    const c2 = { x: v.x + ub.x * s, y: v.y + ub.y * s };
    const c3 = { x: v.x + (ua.x + ub.x) * s, y: v.y + (ua.y + ub.y) * s };
    ops.push({ op: "line", id: `${pid}.r${i}a`, x: c1.x, y: c1.y, x2: c3.x, y2: c3.y, color: col });
    ops.push({ op: "line", id: `${pid}.r${i}b`, x: c2.x, y: c2.y, x2: c3.x, y2: c3.y, color: col });
  }

  const b = boundsOf(pts);
  const bbox = { x: b.x - 40, y: b.y - (heading ? 46 : 40), w: b.w + 80, h: b.h + (heading ? 86 : 80) };
  return { ops, bbox, label: `polygon (${n} pts)` };
}
