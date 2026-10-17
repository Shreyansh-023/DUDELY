/**
 * Deterministic label placement around a polygon outline.
 *
 * The rule a hand-placed label always breaks: a side label must sit OUTSIDE the
 * figure, clear of every stroke, and close enough to its OWN edge that nobody
 * has to guess which side it names. This module computes that placement from
 * the geometry alone — same input, same pixels, every time — for triangles,
 * quadrilaterals and any n-gon, convex or concave, in either winding order.
 *
 * How it works, in order:
 *   1. Outward direction. For an edge it is the edge NORMAL, with its sign taken
 *      from the polygon's signed area — never the ray from the centroid, which
 *      on a thin or elongated shape runs almost ALONG the edge and is what
 *      slides a label onto the figure. For a vertex it is the outward bisector
 *      of its two edges.
 *   2. Stand-off distance. A label is a BOX, not a point, so the distance from
 *      the anchor is `gap + the box's own half-extent along that direction`
 *      (its support function). That is what guarantees the box's near face
 *      clears the edge line by `gap`: offsetting a fixed 18px and then centring
 *      the text on that point leaves any wide label straddling the line.
 *   3. Conflict resolution. Candidates are tried at increasing distance, first
 *      straight out and then along a narrow fan either side of that direction,
 *      so a label whose normal is blocked by another limb of the shape can
 *      slide past it instead of tunnelling through. They are ranked
 *      LEXICOGRAPHICALLY — strokes crossed, then inside-the-shape, then overlap
 *      with labels already placed, then correspondence, then how far it had to
 *      go. A scalar sum would let a big overlap hide behind a small one; this
 *      ordering means a candidate that touches a stroke can never beat one that
 *      does not, at any distance. The first perfect candidate wins outright,
 *      which is the common case and costs one iteration.
 *   4. Leaders. `leader` is set from the FINISHED geometry, not from how far
 *      the box travelled: if the nearest edge to the final box is not the one
 *      the label names, or no clean spot was found at all, the caller draws a
 *      dashed line back to the edge midpoint. Travel distance is only a
 *      backstop. Correspondence is thereby self-enforcing rather than hoped for.
 *
 * Pure geometry: no DOM, no draw ops, no text measurement. Callers measure
 * their own text and turn the returned boxes into whatever they draw.
 */

export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** One label to place: either against edge `index`, or at vertex `index`. */
export type LabelRequest = {
  kind: "edge" | "vertex";
  index: number;
  /** Rendered size of the label box. */
  w: number;
  h: number;
};

export type Placement = {
  kind: "edge" | "vertex";
  index: number;
  /** Top-left of the box, ready to hand to a text op. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The point on the figure this label names (edge midpoint, or the vertex). */
  anchor: Pt;
  /** Unit vector the label was pushed along. */
  dir: Pt;
  /** Distance from the anchor to the centre of the box. */
  distance: number;
  /** Set when the box ended up far enough out to want a leader line. */
  leader: boolean;
};

export type PlaceOptions = {
  /** Clear space between a stroke and the nearest face of a label box. */
  gap?: number;
  /** Clear space between two label boxes. */
  pad?: number;
  /** Increment when a candidate has to be pushed further out. */
  step?: number;
  /**
   * How many increments to try before accepting the least-bad placement.
   * Defaults to enough reach to clear the whole figure — a fixed count leaves
   * a label stranded inside any pocket deeper than `tries * step`.
   */
  tries?: number;
  /**
   * Travel that earns a leader on its own. Only a backstop: a label whose
   * nearest edge is already its own does not need one however far it went.
   */
  leaderAfter?: number;
  /** Boxes already on the board that labels must avoid (e.g. a heading). */
  reserved?: Rect[];
};

const EPS = 1e-9;

const len = (v: Pt): number => Math.hypot(v.x, v.y);

const norm = (v: Pt, fallback: Pt = { x: 0, y: -1 }): Pt => {
  const d = len(v);
  if (!Number.isFinite(d) || d < EPS) return fallback;
  return { x: v.x / d, y: v.y / d };
};

const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;

/** Half-extent of an axis-aligned w x h box measured along unit vector `dir`. */
export function support(dir: Pt, w: number, h: number): number {
  return Math.abs(dir.x) * (w / 2) + Math.abs(dir.y) * (h / 2);
}

/** Twice the signed area (shoelace). Its sign is the winding order. */
export function signedArea2(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

export function centroidOf(pts: Pt[]): Pt {
  const n = pts.length || 1;
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / n,
    y: pts.reduce((s, p) => s + p.y, 0) / n,
  };
}

/** Number of drawn edges: n for a closed shape, n-1 for an open polyline. */
export function edgeCount(n: number, closed: boolean): number {
  if (n < 2) return 0;
  return closed ? n : n - 1;
}

/** The drawn edges of the outline, as [a, b] pairs in index order. */
export function edgesOf(pts: Pt[], closed: boolean): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  const n = pts.length;
  for (let i = 0; i < edgeCount(n, closed); i++) out.push([pts[i], pts[(i + 1) % n]]);
  return out;
}

/** Even-odd point-in-polygon. A tie-breaker only; never used to pick a direction. */
export function pointInPolygon(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || EPS) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

const rectOf = (centre: Pt, w: number, h: number): Rect => ({
  x: centre.x - w / 2,
  y: centre.y - h / 2,
  w,
  h,
});

export const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + 2 * by,
  h: r.h + 2 * by,
});

/** Area shared by two rectangles (0 when they are disjoint). */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Does segment a-b touch rectangle r (a segment wholly inside it counts)? */
export function segmentHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  const x1 = r.x;
  const y1 = r.y;
  const x2 = r.x + r.w;
  const y2 = r.y + r.h;
  if (a.x >= x1 && a.x <= x2 && a.y >= y1 && a.y <= y2) return true;
  if (b.x >= x1 && b.x <= x2 && b.y >= y1 && b.y <= y2) return true;
  // Liang-Barsky clip of the segment against the box.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const slabs: [number, number][] = [
    [-dx, a.x - x1],
    [dx, x2 - a.x],
    [-dy, a.y - y1],
    [dy, y2 - a.y],
  ];
  for (const [p, q] of slabs) {
    if (Math.abs(p) < EPS) {
      if (q < 0) return false; // parallel to this slab and outside it
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 <= t1;
}

/** Distance from point `p` to segment a-b. */
export function pointSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < EPS) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from point `p` to rectangle `r` (0 when inside). */
export function pointRectDistance(p: Pt, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/**
 * Distance from rectangle `r` to segment a-b (0 when they touch). This is the
 * measure the correspondence rule is stated in: a side label belongs to the
 * edge it is NEAREST to, so that is what the placer has to optimise.
 */
export function rectSegmentDistance(r: Rect, a: Pt, b: Pt): number {
  if (segmentHitsRect(a, b, r)) return 0;
  const corners: Pt[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  let m = Math.min(pointRectDistance(a, r), pointRectDistance(b, r));
  for (const c of corners) m = Math.min(m, pointSegmentDistance(c, a, b));
  return m;
}

/** Index of the drawn edge nearest `box`, and that distance. */
export function nearestEdgeTo(box: Rect, edges: [Pt, Pt][]): { index: number; distance: number } {
  let index = -1;
  let distance = Infinity;
  for (let i = 0; i < edges.length; i++) {
    const d = rectSegmentDistance(box, edges[i][0], edges[i][1]);
    if (d < distance) {
      distance = d;
      index = i;
    }
  }
  return { index, distance };
}

const rotate = (v: Pt, rad: number): Pt => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
};

/** Angular spacing of the search fan either side of the outward direction. */
const FAN_STEP = (18 * Math.PI) / 180;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const boundsDiagonal = (pts: Pt[]): number => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

/** One scored position for a label. */
type Candidate = {
  /** Strokes of the figure the box would cross. */
  strokes: number;
  /** 1 when the box centre falls inside a closed shape. */
  inside: number;
  /** Area shared with labels already placed. */
  overlap: number;
  /** 1 when some other edge is nearer than the one this label names. */
  mismatch: number;
  /** Tie-break: distance travelled, plus a nudge favouring straight out. */
  cost: number;
  d: number;
  base: number;
  dir: Pt;
  box: Rect;
};

/**
 * Lexicographic, NOT a weighted sum. Each term strictly dominates the next, so
 * no amount of distance can buy its way past a stroke, and a candidate that
 * overlaps another label can never be chosen over one that does not.
 */
function isBetter(a: Candidate, b: Candidate): boolean {
  if (a.strokes !== b.strokes) return a.strokes < b.strokes;
  if (a.inside !== b.inside) return a.inside < b.inside;
  if (Math.abs(a.overlap - b.overlap) > 1e-6) return a.overlap < b.overlap;
  if (a.mismatch !== b.mismatch) return a.mismatch < b.mismatch;
  return a.cost < b.cost;
}

/**
 * Outward unit normal of edge `i`. The sign comes from the winding order, so it
 * is right for concave shapes too; a degenerate or open outline falls back to
 * "away from the centroid", which is the best guess available there.
 */
export function outwardEdgeNormal(pts: Pt[], i: number, closed: boolean): Pt {
  const n = pts.length;
  const a = pts[i];
  const b = pts[(i + 1) % n];
  const c = centroidOf(pts);
  const d = { x: b.x - a.x, y: b.y - a.y };
  if (len(d) < EPS) return norm({ x: a.x - c.x, y: a.y - c.y });
  const perp = norm({ x: d.y, y: -d.x });
  const area2 = closed && n >= 3 ? signedArea2(pts) : 0;
  if (Math.abs(area2) > EPS) return area2 > 0 ? perp : { x: -perp.x, y: -perp.y };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const away = { x: mid.x - c.x, y: mid.y - c.y };
  return dot(perp, away) >= 0 ? perp : { x: -perp.x, y: -perp.y };
}

/**
 * Outward direction at vertex `i`: the bisector of its two edges, flipped to
 * point out of the shape. A concave corner opens the wrong way, so there we
 * trust the average of the two adjoining edge normals instead. Straight-through
 * vertices fall back to the edge normal, endpoints of an open polyline carry on
 * past the end of their single edge.
 */
export function outwardVertexDir(pts: Pt[], i: number, closed: boolean): Pt {
  const n = pts.length;
  const v = pts[i];
  const c = centroidOf(pts);
  const prev = closed || i > 0 ? pts[(i - 1 + n) % n] : null;
  const next = closed || i < n - 1 ? pts[(i + 1) % n] : null;

  if (prev && next) {
    const ua = norm({ x: prev.x - v.x, y: prev.y - v.y }, { x: 0, y: 0 });
    const ub = norm({ x: next.x - v.x, y: next.y - v.y }, { x: 0, y: 0 });
    const sum = { x: ua.x + ub.x, y: ua.y + ub.y };
    const na = outwardEdgeNormal(pts, (i - 1 + n) % n, closed);
    const nb = outwardEdgeNormal(pts, i, closed);
    const avg = norm({ x: na.x + nb.x, y: na.y + nb.y }, { x: 0, y: -1 });
    if (len(sum) > 1e-6) {
      const inward = norm(sum);
      const outward = { x: -inward.x, y: -inward.y };
      // Agrees with the edge normals on a convex corner; on a reflex one it
      // points back into the shape, and then the normals are the honest answer.
      return dot(outward, avg) >= 0 ? outward : avg;
    }
    return avg; // collinear edges: step off square to the line
  }

  const other = prev ?? next;
  if (other) {
    const along = norm({ x: v.x - other.x, y: v.y - other.y });
    const away = norm({ x: v.x - c.x, y: v.y - c.y }, along);
    return norm({ x: along.x + away.x, y: along.y + away.y }, along);
  }
  return norm({ x: v.x - c.x, y: v.y - c.y });
}

/** The point a label is measured from: an edge midpoint, or the vertex itself. */
export function anchorOf(pts: Pt[], req: { kind: "edge" | "vertex"; index: number }): Pt {
  const n = pts.length;
  if (req.kind === "vertex") return pts[req.index];
  const a = pts[req.index];
  const b = pts[(req.index + 1) % n];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Place every requested label around the outline. Vertex labels go first (they
 * are short, and corner letters are the strongest convention on the page), then
 * the side labels, which are the ones allowed to travel and grow a leader.
 * Within each group the order is by index, so the output is stable. Results
 * come back in REQUEST order so callers can zip them with their own input.
 */
export function placeOutlineLabels(
  pts: Pt[],
  closed: boolean,
  requests: LabelRequest[],
  options: PlaceOptions = {},
): Placement[] {
  const gap = options.gap ?? 10;
  const pad = options.pad ?? 8;
  const step = options.step ?? 6;
  const leaderAfter = options.leaderAfter ?? 72;
  const reserved = options.reserved ?? [];

  const n = pts.length;
  if (n < 2) return [];
  const edges = edgesOf(pts, closed);
  const nEdges = edges.length;
  const simple = closed && n >= 3 && Math.abs(signedArea2(pts)) > EPS;

  // Reach has to beat the figure, or a label in a deep pocket never escapes it.
  const span = boundsDiagonal(pts);
  const tries = options.tries ?? clamp(Math.ceil(span / step) + 8, 24, 260);
  // A fan either side of the outward direction, so a blocked label can slide
  // past an obstruction instead of marching through it. Trimmed on very busy
  // outlines, where the extra directions cost more than they buy.
  const fan = nEdges > 40 ? [0, 1, -1] : [0, 1, -1, 2, -2, 3, -3];

  const valid = requests.filter((r) =>
    r.kind === "edge" ? r.index >= 0 && r.index < nEdges : r.index >= 0 && r.index < n,
  );
  const order = [
    ...valid.filter((r) => r.kind === "vertex").sort((a, b) => a.index - b.index),
    ...valid.filter((r) => r.kind === "edge").sort((a, b) => a.index - b.index),
  ];

  const placed: Placement[] = [];
  const taken: Rect[] = [...reserved];

  for (const req of order) {
    const anchor = anchorOf(pts, req);
    const home =
      req.kind === "edge"
        ? outwardEdgeNormal(pts, req.index, closed)
        : outwardVertexDir(pts, req.index, closed);

    let best: Candidate | null = null;
    search: for (let f = 0; f < fan.length; f++) {
      const dir = fan[f] === 0 ? home : rotate(home, fan[f] * FAN_STEP);
      const base = gap + support(dir, req.w, req.h);
      for (let k = 0; k <= tries; k++) {
        const d = base + k * step;
        const centre = { x: anchor.x + dir.x * d, y: anchor.y + dir.y * d };
        const box = rectOf(centre, req.w, req.h);

        let strokes = 0;
        const clearance = inflate(box, gap / 2);
        for (const [a, b] of edges) if (segmentHitsRect(a, b, clearance)) strokes++;
        const inside = simple && pointInPolygon(centre, pts) ? 1 : 0;
        let overlap = 0;
        for (const t of taken) overlap += overlapArea(inflate(box, pad / 2), t);
        // Correspondence: a tie at a shared corner is honest, so allow 1px.
        let mismatch = 0;
        if (req.kind === "edge" && nEdges > 1) {
          const near = nearestEdgeTo(box, edges);
          const own = rectSegmentDistance(box, edges[req.index][0], edges[req.index][1]);
          mismatch = near.index !== req.index && own > near.distance + 1 ? 1 : 0;
        }
        // Prefer the straight-out direction; `f` only breaks ties on distance.
        const cand: Candidate = {
          strokes,
          inside,
          overlap,
          mismatch,
          cost: d + f * 8,
          d,
          base,
          dir,
          box,
        };
        if (!best || isBetter(cand, best)) best = cand;
        if (!strokes && !inside && overlap <= 1e-6 && !mismatch) break search;
      }
    }

    const pick =
      best ??
      ({
        strokes: 0,
        inside: 0,
        overlap: 0,
        mismatch: 0,
        cost: 0,
        d: gap,
        base: gap,
        dir: home,
        box: rectOf({ x: anchor.x + home.x * gap, y: anchor.y + home.y * gap }, req.w, req.h),
      } as Candidate);

    taken.push(inflate(pick.box, pad / 2));
    placed.push({
      kind: req.kind,
      index: req.index,
      x: pick.box.x,
      y: pick.box.y,
      w: pick.box.w,
      h: pick.box.h,
      anchor,
      dir: pick.dir,
      distance: pick.d,
      // Drawn when the finished geometry needs it — the label ended up nearer
      // another edge, or never found a clean spot — not merely when it moved.
      leader:
        pick.mismatch > 0 ||
        pick.strokes > 0 ||
        pick.inside > 0 ||
        pick.d - pick.base > leaderAfter,
    });
  }

  const byKey = new Map(placed.map((p) => [`${p.kind}:${p.index}`, p]));
  return requests
    .map((r) => byKey.get(`${r.kind}:${r.index}`))
    .filter((p): p is Placement => !!p);
}

/** Union of a set of rectangles, or null when there are none. */
export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Where a leader line should meet the label: the point on the box border
 * nearest the anchor, pulled back by `inset` so the line stops short of the
 * glyphs instead of touching them.
 */
export function leaderEnd(anchor: Pt, box: Rect, inset = 3): Pt {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = anchor.x - cx;
  const dy = anchor.y - cy;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return { x: cx, y: cy };
  const tx = Math.abs(dx) > EPS ? box.w / 2 / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > EPS ? box.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  const ex = cx + dx * t;
  const ey = cy + dy * t;
  const d = Math.hypot(ex - anchor.x, ey - anchor.y);
  if (d < inset) return { x: ex, y: ey };
  return { x: ex + ((anchor.x - ex) / d) * inset, y: ey + ((anchor.y - ey) / d) * inset };
}
