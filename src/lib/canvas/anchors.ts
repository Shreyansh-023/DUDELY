import type { DrawOp } from "../schema";
import { CONTENT_BOTTOM, CONTENT_LEFT, CONTENT_RIGHT, CONTENT_TOP } from "./page";
import {
  inflate,
  leaderEnd,
  overlapArea,
  placeOutlineLabels,
  pointInPolygon,
  segmentHitsRect,
  support,
  type Pt,
  type Rect,
} from "./primitives/place";
import { measureText, textBox, type Anchors, type Expanded } from "./primitives/util";

/**
 * Figure anchors: drawing ON a figure by naming its parts.
 *
 * A polygon the board has placed knows where its vertices and sides really are
 * (after the layout engine moved and maybe shrank it). An op that says
 * `at: "A"` is resolved against THAT geometry, so an angle mark lands on the
 * corner, a side label sits beside its side, a highlight runs along the edge,
 * and an altitude meets the opposite side at a right angle — none of which a
 * model working from imagined coordinates could do reliably, and none of which
 * a collision pass could repair without moving the mark off its corner.
 *
 * Pure geometry on a `Figure` record: no DOM, no scene. The player keeps the
 * registry and hands in the figure; everything returned is page-local ops.
 */

export type Figure = {
  id: string;
  page: number;
  /** The turn (lesson step) that drew it. */
  turn?: number;
  anchors: Anchors;
  /** Label boxes already placed around this figure, so new ones avoid them. */
  labelBoxes: Rect[];
  /** Vertices an angle mark has been put on, in order: "opposite"/"adjacent" are read against the first acute one. */
  markedVertices: string[];
  /** Construction lines drawn on this figure (altitudes, diagonals): labels keep clear of them too. */
  segments: [Pt, Pt][];
};

/** Index of a triangle's right-angle vertex, or -1. */
export function rightAngleIndex(o: Pt[]): number {
  if (o.length !== 3) return -1;
  for (let i = 0; i < 3; i++) {
    const v = o[i];
    const ua = unit(sub(o[(i + 2) % 3], v));
    const ub = unit(sub(o[(i + 1) % 3], v));
    if (Math.abs(ua.x * ub.x + ua.y * ub.y) <= 0.09) return i;
  }
  return -1;
}

/**
 * The side a role-word label really belongs on. In a right triangle
 * "hypotenuse" is the side opposite the right angle and nothing else, and
 * "opposite"/"adjacent" are read against the acute angle that has been marked
 * — however the model named the side. A label like "5 cm" or "AB" is left on
 * the side the model named.
 */
export function retargetSide(fig: Figure, name: string, text: string): string {
  const o = fig.anchors.outline;
  // A label that is simply a side's name ("BC") belongs on that side, whichever
  // side the model attached it to.
  const asName = text.trim();
  if (/^[A-Za-z]{2}$/.test(asName) && segmentOf(fig, asName) && segmentOf(fig, asName)!.index >= 0) return asName;
  if (!fig.anchors.closed || o.length !== 3) return name;
  const seg = segmentOf(fig, name);
  if (!seg || seg.index < 0) return name;
  const right = rightAngleIndex(o);
  if (right < 0) return name;
  const vi = fig.anchors.vertexIndex;
  const names = o.map((_, i) => Object.keys(vi).find((k) => vi[k] === i && !/^v\d+$/.test(k)) ?? `v${i}`);
  const sideName = (edge: number) => `${names[edge]}${names[(edge + 1) % 3]}`;
  const hyp = (right + 1) % 3; // the edge not touching the right-angle vertex
  const t = text.toLowerCase();
  if (/hypot/.test(t)) return sideName(hyp);
  if (/\b(opposite|adjacent)\b/.test(t)) {
    const marked = fig.markedVertices.map((v) => vi[v]).filter((i) => i != null && i !== right);
    const a = marked[0];
    if (a == null) return name;
    const oppositeEdge = (a + 1) % 3;
    const adjacentLeg = [a, (a + 2) % 3].find((e) => e !== hyp)!;
    return sideName(/\bopposite\b/.test(t) ? oppositeEdge : adjacentLeg);
  }
  return name;
}

const FONT = 16;
const LABEL_H = 20;

/** `anchors` moved by (dx, dy) after scaling by `s` — the figure's committed geometry. */
export function transformAnchors(a: Anchors, s: number, dx: number, dy: number): Anchors {
  const t = (p: Pt): Pt => ({ x: p.x * s + dx, y: p.y * s + dy });
  const points: Record<string, Pt> = {};
  for (const [k, p] of Object.entries(a.points)) points[k] = t(p);
  return { ...a, points, outline: a.outline.map(t) };
}

/** Split "tri1.A" into the figure it names and the part; a bare "A" names no figure. */
export function splitAnchorRef(spec: string): { of: string | null; name: string } {
  const m = /^([A-Za-z0-9_-]+)\.(.+)$/.exec(spec.trim());
  return m ? { of: m[1], name: m[2] } : { of: null, name: spec.trim() };
}

const unit = (v: Pt): Pt => {
  const d = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / d, y: v.y / d };
};
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt, k = 1): Pt => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const key = (s: string) => s.replace(/[\s\-–_]+/g, "");

export function edgeOf(fig: Figure, name: string): { index: number; a: Pt; b: Pt } | null {
  const k = key(name);
  const idx = fig.anchors.edgeIndex[k];
  if (idx == null) return null;
  const o = fig.anchors.outline;
  return { index: idx, a: o[idx], b: o[(idx + 1) % o.length] };
}

export function vertexOf(fig: Figure, name: string): { index: number; p: Pt } | null {
  const idx = fig.anchors.vertexIndex[name.trim()];
  if (idx == null) return null;
  return { index: idx, p: fig.anchors.outline[idx] };
}

/**
 * The segment a two-vertex name refers to: a drawn side ("AB", with its edge
 * index) or, failing that, any two of the figure's vertices ("AD" across a
 * quadrilateral — a diagonal, index -1). Null when the name is not two vertices.
 */
export function segmentOf(fig: Figure, name: string): { index: number; a: Pt; b: Pt } | null {
  const e = edgeOf(fig, name);
  if (e) return e;
  const k = key(name);
  const names = Object.keys(fig.anchors.vertexIndex).filter((n) => !/^v\d+$/.test(n));
  for (const first of names) {
    if (!k.startsWith(first)) continue;
    const second = k.slice(first.length);
    if (second && names.includes(second) && second !== first) {
      return { index: -1, a: fig.anchors.outline[fig.anchors.vertexIndex[first]], b: fig.anchors.outline[fig.anchors.vertexIndex[second]] };
    }
  }
  return null;
}

/**
 * The point a name refers to: a vertex ("A"), the midpoint of a side ("AB",
 * "mid AB"), the foot of the perpendicular from a vertex onto a side
 * ("foot A BC"), or "centroid". Null when the name is not one of this
 * figure's parts — the caller drops the op rather than guess.
 */
export function resolvePoint(fig: Figure, spec: string): Pt | null {
  const words = spec.trim().split(/\s+/);
  const head = words[0]?.toLowerCase();
  if (head === "mid" || head === "midpoint") {
    const e = segmentOf(fig, words.slice(1).join(""));
    return e ? mid(e.a, e.b) : null;
  }
  if (head === "foot") {
    const v = vertexOf(fig, words[1] ?? "");
    const e = segmentOf(fig, words.slice(2).join(""));
    if (!v || !e) return null;
    return footOfPerpendicular(v.p, e.a, e.b);
  }
  if (head === "centroid" || head === "centre" || head === "center") return fig.anchors.points.centroid ?? null;
  const named = fig.anchors.points[spec.trim()];
  if (named) return named;
  const e = segmentOf(fig, spec);
  return e ? mid(e.a, e.b) : null;
}

export function footOfPerpendicular(p: Pt, a: Pt, b: Pt): Pt {
  const d = sub(b, a);
  const l2 = d.x * d.x + d.y * d.y || 1;
  const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2;
  return { x: a.x + d.x * t, y: a.y + d.y * t };
}

const CONTENT: Rect = { x: CONTENT_LEFT, y: CONTENT_TOP, w: CONTENT_RIGHT - CONTENT_LEFT, h: CONTENT_BOTTOM - CONTENT_TOP };
const within = (r: Rect, outer: Rect) =>
  r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;

/** The two edges meeting at the vertex, as unit vectors away from it, and their lengths. */
function cornerRays(fig: Figure, index: number): { ua: Pt; ub: Pt; la: number; lb: number } | null {
  const o = fig.anchors.outline;
  const n = o.length;
  if (n < 3 && !(n === 2)) return null;
  const v = o[index];
  const closed = fig.anchors.closed;
  const prev = closed || index > 0 ? o[(index - 1 + n) % n] : null;
  const next = closed || index < n - 1 ? o[(index + 1) % n] : null;
  if (!prev || !next) return null;
  const da = sub(prev, v);
  const db = sub(next, v);
  return { ua: unit(da), ub: unit(db), la: Math.hypot(da.x, da.y), lb: Math.hypot(db.x, db.y) };
}

/**
 * The angle mark at a vertex: an arc between the two sides, inside the corner,
 * and its label on the bisector just past the arc — never a ray (the sides are
 * already drawn), never on top of the arc, never across a side. If the label
 * cannot sit inside the corner (a very narrow angle) it goes outside, on the
 * far side of the vertex. A right angle is already marked by the polygon's own
 * square, so only the label is added there.
 */
export function anchoredAngle(
  fig: Figure,
  at: string,
  op: { id?: string | null; text?: string | null; color?: DrawOp["color"]; r?: number | null },
): (Expanded & { box?: Rect }) | null {
  const v = vertexOf(fig, at);
  if (!v) return null;
  const rays = cornerRays(fig, v.index);
  if (!rays) return null;
  const { ua, ub, la, lb } = rays;
  const pid = (op.id || `ang_${fig.id}_${at}`).replace(/[^a-zA-Z0-9_-]/g, "_");
  const col = op.color ?? "blue";
  const ops: DrawOp[] = [];
  const o = fig.anchors.outline;

  // Interior side of the corner: the bisector, flipped if it leaves the shape.
  let bis = unit(add(ua, ub));
  if (Math.hypot(bis.x, bis.y) < 1e-6) bis = unit({ x: -ua.y, y: ua.x }); // straight through
  const simple = fig.anchors.closed && o.length >= 3;
  if (simple && !pointInPolygon(add(v.p, bis, 2), o)) bis = { x: -bis.x, y: -bis.y };

  // Sweep from ua to ub the way round that passes through the interior.
  const a0 = Math.atan2(ua.y, ua.x);
  const a1 = Math.atan2(ub.y, ub.x);
  let d = a1 - a0;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d > Math.PI) d -= 2 * Math.PI;
  const midDir = { x: Math.cos(a0 + d / 2), y: Math.sin(a0 + d / 2) };
  if (midDir.x * bis.x + midDir.y * bis.y < 0) d = d - Math.sign(d) * 2 * Math.PI;
  const deg = Math.round((Math.abs(d) * 180) / Math.PI);
  const right = Math.abs(ua.x * ub.x + ua.y * ub.y) <= 0.09 && deg < 180;

  const shorter = Math.min(la, lb);
  const arcR = Math.max(16, Math.min(op.r ?? 0.2 * shorter, 0.4 * shorter, 34));
  if (!right) {
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const t0 = a0 + (d * i) / steps;
      const t1 = a0 + (d * (i + 1)) / steps;
      ops.push({
        op: "line",
        id: `${pid}.a${i}`,
        x: v.p.x + Math.cos(t0) * arcR,
        y: v.p.y + Math.sin(t0) * arcR,
        x2: v.p.x + Math.cos(t1) * arcR,
        y2: v.p.y + Math.sin(t1) * arcR,
        color: col,
      });
    }
  }

  const text = (op.text ?? `${deg}°`).trim();
  let labelBox: Rect | null = null;
  if (text) {
    const w = measureText(text, FONT);
    const h = LABEL_H;
    const edges: [Pt, Pt][] = [
      [v.p, add(v.p, ua, la)],
      [v.p, add(v.p, ub, lb)],
    ];
    const obstacles = [...edges, ...fig.segments];
    const clean = (box: Rect) =>
      within(box, CONTENT) &&
      !obstacles.some(([a, b]) => segmentHitsRect(a, b, inflate(box, 4))) &&
      !fig.labelBoxes.some((r) => overlapArea(inflate(box, 2), r) > 0);
    const boxAt = (dir: Pt, dist: number): Rect => {
      const c = add(v.p, dir, dist);
      return { x: c.x - w / 2, y: c.y - h / 2, w, h };
    };
    // Inside the corner, past the arc; pushed further out until it clears both sides.
    let box: Rect | null = null;
    const base = (right ? 14 : arcR + 8) + support(bis, w, h);
    for (let k = 0; k < 8 && !box; k++) {
      const cand = boxAt(bis, base + k * 8);
      if (clean(cand)) box = cand;
    }
    if (!box) {
      // Outside the vertex, on the far side.
      const out = { x: -bis.x, y: -bis.y };
      for (let k = 0; k < 12 && !box; k++) {
        const cand = boxAt(out, 10 + support(out, w, h) + k * 8);
        if (clean(cand)) box = cand;
      }
    }
    labelBox = box ?? boxAt(bis, base);
    ops.push({ op: "text", id: `${pid}.lbl`, x: labelBox.x, y: labelBox.y, text, size: "sm", color: col });
  }

  const xs = ops.flatMap((o2) => [o2.x ?? 0, o2.x2 ?? o2.x ?? 0]);
  const ys = ops.flatMap((o2) => [o2.y ?? 0, o2.y2 ?? o2.y ?? 0]);
  if (labelBox) {
    xs.push(labelBox.x + labelBox.w);
    ys.push(labelBox.y + labelBox.h);
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const bbox = { x: x - 4, y: y - 4, w: Math.max(...xs) - x + 8, h: Math.max(...ys) - y + 8 };
  return { ops, bbox, label: `angle ${text || `${deg}°`} at ${at}`, box: labelBox ?? undefined };
}

/**
 * The one rule every label on a figure obeys: it must not cross a stroke of
 * the figure, a construction line on it, or any label already placed, and it
 * must stay inside the page. Candidates start square to the segment on either
 * side of `anchor` and step outward; the first clean one wins.
 */
export function placeLabelBeside(fig: Figure, anchor: Pt, dir: Pt, w: number, h: number, extra: [Pt, Pt][] = []): Rect {
  const o = fig.anchors.outline;
  const edges: [Pt, Pt][] = o.map((p, i) => [p, o[(i + 1) % o.length]] as [Pt, Pt]);
  edges.push(...fig.segments, ...extra);
  const clean = (box: Rect) =>
    within(box, CONTENT) &&
    !edges.some(([a, b]) => segmentHitsRect(a, b, inflate(box, 4))) &&
    !fig.labelBoxes.some((r) => overlapArea(inflate(box, 4), r) > 0);
  const n = unit(dir);
  for (let k = 0; k < 10; k++) {
    for (const d of [n, { x: -n.x, y: -n.y }]) {
      const c = add(anchor, d, 8 + support(d, w, h) + k * 8);
      const cand = { x: c.x - w / 2, y: c.y - h / 2, w, h };
      if (clean(cand)) return cand;
    }
  }
  const c = add(anchor, n, 8 + support(n, w, h));
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/**
 * The text of a construction line (an altitude, a line of sight): beside the
 * line's midpoint, clear of the figure and of every other label.
 */
export function segmentLabel(fig: Figure, a: Pt, b: Pt, op: { id?: string | null; text?: string | null; color?: DrawOp["color"] }): (Expanded & { box: Rect }) | null {
  const text = (op.text ?? "").trim();
  if (!text) return null;
  const w = measureText(text, FONT);
  const h = LABEL_H;
  const along = unit(sub(b, a));
  let n = { x: -along.y, y: along.x };
  if (n.y > 0) n = { x: -n.x, y: -n.y }; // try the upper side first
  const box = placeLabelBeside(fig, mid(a, b), n, w, h, [[a, b]]);
  const pid = (op.id ? `${op.id}.t` : `seg_${fig.id}`).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return { ops: [{ op: "text", id: pid, x: box.x, y: box.y, text, size: "sm", color: op.color ?? "blue" }], bbox: box, label: `label "${text}"`, box };
}

/**
 * A label beside a side or a vertex, placed by the same rule the polygon uses
 * for its own labels (outside the figure, clear of every stroke and of every
 * label already there, with a leader if it had to travel).
 */
export function anchoredLabel(
  fig: Figure,
  at: string,
  op: { id?: string | null; text?: string | null; color?: DrawOp["color"]; size?: DrawOp["size"] },
): (Expanded & { box: Rect }) | null {
  const text = (op.text ?? "").trim();
  if (!text) return null;
  const fontPx = op.size === "md" ? 24 : op.size === "lg" ? 36 : FONT;
  const req = (() => {
    const v = vertexOf(fig, at);
    if (v) return { kind: "vertex" as const, index: v.index };
    // "mid BC" and "foot A BC" are points ON side BC: the label goes beside that side.
    const words = at.trim().split(/\s+/);
    const head = words[0]?.toLowerCase();
    const edgeName = head === "mid" || head === "midpoint" ? words.slice(1).join("") : head === "foot" ? words.slice(2).join("") : at;
    const e = edgeOf(fig, edgeName);
    if (e) return { kind: "edge" as const, index: e.index };
    return null;
  })();
  const { w, h } = textBox(text, fontPx);
  const pid = (op.id || `lbl_${fig.id}_${at}`).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!req) {
    // Not a side or a vertex: a diagonal (or a point on one). The label sits
    // beside the segment's midpoint, square to it, on whichever side is clear
    // of the figure's strokes and of the labels already there.
    const words = at.trim().split(/\s+/);
    const head = words[0]?.toLowerCase();
    const segName = head === "mid" || head === "midpoint" ? words.slice(1).join("") : head === "foot" ? words.slice(2).join("") : at;
    const seg = segmentOf(fig, segName);
    if (!seg) return null;
    const along = unit(sub(seg.b, seg.a));
    const box = placeLabelBeside(fig, mid(seg.a, seg.b), { x: -along.y, y: along.x }, w, h, [[seg.a, seg.b]]);
    const ops: DrawOp[] = [{ op: "text", id: pid, x: box.x, y: box.y, text, size: op.size ?? "sm", color: op.color ?? "blue" }];
    return { ops, bbox: box, label: `label "${text}" at ${at}`, box };
  }
  const [p] = placeOutlineLabels(fig.anchors.outline, fig.anchors.closed, [{ ...req, w, h }], { reserved: fig.labelBoxes });
  if (!p) return null;
  const ops: DrawOp[] = [];
  if (p.leader) {
    const end = leaderEnd(p.anchor, p);
    ops.push({ op: "line", id: `${pid}.L`, x: p.anchor.x, y: p.anchor.y, x2: end.x, y2: end.y, color: "gray", dash: true });
  }
  ops.push({ op: "text", id: pid, x: p.x, y: p.y, text, size: op.size ?? "sm", color: op.color ?? "blue" });
  const box = { x: p.x, y: p.y, w: p.w, h: p.h };
  return { ops, bbox: box, label: `label "${text}" at ${at}`, box };
}

/**
 * A translucent band along a side, a ring round a vertex, or a box round the
 * whole figure. The band is a rotated rectangle: `rot` carries the side's angle
 * to the skeleton (Excalidraw rotates about the centre, so x/y are the
 * unrotated top-left).
 */
export function anchoredHighlight(fig: Figure, at: string, op: { id?: string | null; temp?: boolean | null }): DrawOp | null {
  const id = op.id ?? undefined;
  // A highlight is a pointing gesture unless the model says it is notes.
  const temp = op.temp ?? true;
  const v = vertexOf(fig, at);
  if (v) {
    const r = 20;
    return { op: "highlight", id, x: v.p.x - r, y: v.p.y - r, w: 2 * r, h: 2 * r, temp };
  }
  const e = segmentOf(fig, at);
  if (e) {
    const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) + 16;
    const band = 26;
    const m = mid(e.a, e.b);
    return { op: "highlight", id, x: m.x - len / 2, y: m.y - band / 2, w: len, h: band, rot: Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x), temp };
  }
  const name = key(at);
  const whole = Object.keys(fig.anchors.vertexIndex).join("");
  if (name === key(whole) || name.toLowerCase() === "all" || name === fig.id) {
    const o = fig.anchors.outline;
    const xs = o.map((p) => p.x);
    const ys = o.map((p) => p.y);
    const x = Math.min(...xs) - 12;
    const y = Math.min(...ys) - 12;
    return { op: "highlight", id, x, y, w: Math.max(...xs) - x + 12, h: Math.max(...ys) - y + 12, temp };
  }
  return null;
}

/** A construction segment between two named points (an altitude, a median, a diagonal). */
export function anchoredSegment(fig: Figure, op: DrawOp): DrawOp | null {
  const a = op.from ? resolvePoint(fig, op.from) : null;
  const b = op.to ? resolvePoint(fig, op.to) : null;
  if (!a || !b) return null;
  return {
    op: op.op === "arrow" ? "arrow" : "line",
    id: op.id ?? undefined,
    x: a.x,
    y: a.y,
    x2: b.x,
    y2: b.y,
    color: op.color ?? "red",
    dash: op.dash ?? undefined,
    text: op.text ?? undefined,
    // A construction on a figure is part of the notes unless the model says otherwise.
    temp: op.temp ?? false,
  };
}

/** A highlight over an element the board already holds, by its committed bounds. */
export function elementHighlight(bounds: Rect, op: { id?: string | null; temp?: boolean | null }): DrawOp {
  const pad = 6;
  return { op: "highlight", id: op.id ?? undefined, x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + 2 * pad, h: bounds.h + 2 * pad, temp: op.temp ?? true };
}

/** A short pointing arrow at an element: from the left margin, or from above when there is no room. */
export function pointerArrow(bounds: Rect, op: { id?: string | null; temp?: boolean | null; color?: DrawOp["color"]; text?: string | null }): DrawOp {
  const cy = bounds.y + bounds.h / 2;
  const fromLeft = bounds.x - 84 >= 8;
  const base = { op: "arrow" as const, id: op.id ?? undefined, color: op.color ?? "orange", text: op.text ?? undefined, temp: op.temp ?? true };
  return fromLeft
    ? { ...base, x: bounds.x - 84, y: cy, x2: bounds.x - 8, y2: cy }
    : { ...base, x: bounds.x + bounds.w / 2, y: bounds.y - 72, x2: bounds.x + bounds.w / 2, y2: bounds.y - 6 };
}
