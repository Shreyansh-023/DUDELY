import type { DrawOp } from "../../schema";
import { boundsOf, textBox, type Expanded } from "./util";
import {
  leaderEnd,
  placeOutlineLabels,
  signedArea2,
  unionRects,
  type LabelRequest,
  type Pt,
  type Rect,
} from "./place";

/**
 * Lowers a high-level `polygon` op into a closed shape whose vertices the model
 * supplies, but whose LABELS the renderer places.
 *
 * The placement is deterministic geometry (see `place.ts`), and it is what
 * makes "side a is labelled a" true rather than hopeful: every side label is
 * pushed out along its OWN edge's outward normal, by its own half-width, so the
 * box sits square to that edge, outside the figure, touching nothing — and if a
 * crowded corner forces it further out, a thin leader line runs back to the
 * edge midpoint so the pairing is still unmistakable. Vertex labels get the
 * same treatment along the outward corner bisector, and 90-degree corners are
 * marked automatically.
 *
 * Works for triangles (incl. Pythagoras), quadrilaterals and any n-gon, convex
 * or concave, with the vertices given in either winding order.
 */

const FONT = 16;
const HEADING_FONT = 24;

export function expandPolygon(op: DrawOp): Expanded {
  const pid = (op.id || "poly").replace(/[^a-zA-Z0-9_-]/g, "_");
  // A closed shape is closed by `closed`, not by repeating its first vertex. Models
  // routinely send the first point again as the last ("a square" as 5 points), which
  // would otherwise draw a zero-length edge and ask for a duplicate corner label.
  const valid = (op.points ?? []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const srcPoints =
    valid.length > 2 && valid[0].x === valid[valid.length - 1].x && valid[0].y === valid[valid.length - 1].y
      ? valid.slice(0, -1)
      : valid;
  const pts: Pt[] = srcPoints.map((p) => ({ x: p.x, y: p.y }));
  const col = op.color ?? "black";
  if (pts.length < 2) {
    return { ops: [], bbox: { x: op.x ?? 0, y: op.y ?? 0, w: 1, h: 1 }, label: "polygon (empty)" };
  }
  const closed = op.closed ?? true;
  const n = pts.length;
  const ops: DrawOp[] = [];
  const boxes: Rect[] = [];

  const heading = (op.text ?? "").trim();
  const bounds = boundsOf(pts);

  // Edges.
  const edgeCount = closed ? n : n - 1;
  for (let i = 0; i < edgeCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    ops.push({ op: "line", id: `${pid}.e${i}`, x: a.x, y: a.y, x2: b.x, y2: b.y, color: col });
  }

  // Right-angle marks at 90-degree corners. Computed BEFORE the labels so the
  // little square is an obstacle a vertex letter has to avoid, not something
  // drawn on top of it afterwards. A reflex corner is skipped: |cos| cannot
  // tell 90 from 270, and a square asserting "right angle" in the notch of a
  // concave shape is simply false.
  const area2 = closed && n >= 3 ? signedArea2(pts) : 0;
  const reserved: Rect[] = [];
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue; // endpoints have one edge
    const v = pts[i];
    const ua = unit({ x: pts[(i - 1 + n) % n].x - v.x, y: pts[(i - 1 + n) % n].y - v.y });
    const ub = unit({ x: pts[(i + 1) % n].x - v.x, y: pts[(i + 1) % n].y - v.y });
    if (Math.abs(ua.x * ub.x + ua.y * ub.y) > 0.09) continue; // not a right angle
    const cross = ua.x * ub.y - ua.y * ub.x;
    if (area2 !== 0 && cross * area2 >= 0) continue; // reflex: 270, not 90
    const s = 12;
    const c1 = { x: v.x + ua.x * s, y: v.y + ua.y * s };
    const c2 = { x: v.x + ub.x * s, y: v.y + ub.y * s };
    const c3 = { x: v.x + (ua.x + ub.x) * s, y: v.y + (ua.y + ub.y) * s };
    ops.push({ op: "line", id: `${pid}.r${i}a`, x: c1.x, y: c1.y, x2: c3.x, y2: c3.y, color: col });
    ops.push({ op: "line", id: `${pid}.r${i}b`, x: c2.x, y: c2.y, x2: c3.x, y2: c3.y, color: col });
    const mb = boundsOf([v, c1, c2, c3]);
    reserved.push({ x: mb.x, y: mb.y, w: mb.w, h: mb.h });
  }

  // Every label is requested up front so they are placed against one another
  // as well as against the strokes — a side label never lands on a vertex
  // letter, and two side labels never land on each other.
  const sides = op.sides ?? [];
  const sideText: string[] = [];
  const vertexText: string[] = [];
  const requests: LabelRequest[] = [];

  // Every labelled corner carrying the SAME word is not four corners called that —
  // it is one shape called that, and the model had no other way to say so (a polygon
  // has no "name this region" field). Printing it per vertex put "surface" four times
  // around one box. Collapse it to a single label in the middle of the shape.
  const labelled = srcPoints.map((p) => (p.label ?? "").trim()).filter(Boolean);
  const wholeShapeName =
    labelled.length > 1 && new Set(labelled).size === 1 && (!heading || heading === labelled[0])
      ? labelled[0]
      : "";

  for (let i = 0; i < n; i++) {
    const t = wholeShapeName ? "" : (srcPoints[i].label ?? "").trim();
    vertexText[i] = t;
    if (!t) continue;
    const b = textBox(t, FONT);
    requests.push({ kind: "vertex", index: i, w: b.w, h: b.h });
  }
  for (let i = 0; i < edgeCount; i++) {
    const t = (sides[i] ?? "").trim();
    sideText[i] = t;
    if (!t) continue;
    const b = textBox(t, FONT);
    requests.push({ kind: "edge", index: i, w: b.w, h: b.h });
  }

  const placements = placeOutlineLabels(pts, closed, requests, { reserved });

  for (const p of placements) {
    const text = p.kind === "edge" ? sideText[p.index] : vertexText[p.index];
    if (!text) continue;
    const id = p.kind === "edge" ? `${pid}.s${p.index}` : `${pid}.v${p.index}`;
    const color = p.kind === "edge" ? "blue" : srcPoints[p.index].color ?? "black";
    // A label that had to be pushed clear of a crowded corner gets a hairline
    // back to the midpoint of the side it names, so the pairing stays obvious.
    if (p.leader) {
      const end = leaderEnd(p.anchor, p);
      ops.push({
        op: "line",
        id: `${id}L`,
        x: p.anchor.x,
        y: p.anchor.y,
        x2: end.x,
        y2: end.y,
        color: "gray",
        dash: true,
      });
    }
    ops.push({ op: "text", id, x: p.x, y: p.y, text, size: "sm", color });
    boxes.push({ x: p.x, y: p.y, w: p.w, h: p.h });
  }

  // The one name the whole shape had, centred inside it.
  if (wholeShapeName) {
    const b = textBox(wholeShapeName, FONT);
    const x = bounds.x + (bounds.w - b.w) / 2;
    const y = bounds.y + (bounds.h - b.h) / 2;
    ops.push({
      op: "text",
      id: `${pid}.name`,
      x,
      y,
      text: wholeShapeName,
      size: "sm",
      color: srcPoints.find((p) => (p.label ?? "").trim())?.color ?? "black",
    });
    boxes.push({ x, y, w: b.w, h: b.h });
  }

  // The heading goes on LAST, above everything already placed. Reserving a
  // fixed band at `bounds.y - 40` before placing is what used to shove every
  // top-side label past the title and manufacture a leader straight through
  // the words; a title has no geometric anchor, so it is the thing that should
  // give way. It is unshifted to the front so the draw order is unchanged.
  const shape: Rect = { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
  const placedExtent = unionRects([shape, ...reserved, ...boxes]) ?? shape;
  if (heading) {
    const hb = textBox(heading, HEADING_FONT);
    const hy = placedExtent.y - hb.h - 12;
    ops.unshift({
      op: "text",
      id: `${pid}.h`,
      x: bounds.x,
      y: hy,
      text: heading,
      size: "md",
      color: "purple",
    });
    boxes.push({ x: bounds.x, y: hy, w: hb.w, h: hb.h });
  }

  // The figure's own extent plus every label we actually placed, so the page
  // layout reserves room for labels that had to travel.
  const all = unionRects([shape, ...reserved, ...boxes]) ?? shape;
  const bbox = { x: all.x - 16, y: all.y - 16, w: all.w + 32, h: all.h + 32 };
  return { ops, bbox, label: `polygon (${n} pts)` };
}

function unit(v: Pt): Pt {
  const d = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / d, y: v.y / d };
}
