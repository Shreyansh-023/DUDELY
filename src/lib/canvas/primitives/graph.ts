import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `graph` op into a node-link diagram: each node is a labelled ellipse,
 * and each edge is an arrow drawn between node BOUNDARIES (shortened so the
 * arrowhead stops at the ellipse, never inside the label). Nodes use the given
 * x/y, or are auto-arranged on a circle when positions are omitted (good for life
 * cycles). Use for food webs, life cycles, concept maps and flow diagrams.
 */

const FONT = 16;
const NODE_H = 38;

export function expandGraph(op: DrawOp): Expanded {
  const pid = (op.id || "gr").replace(/[^a-zA-Z0-9_-]/g, "_");
  const raw = (op.nodes ?? []).filter((n) => n && n.id);
  const ops: DrawOp[] = [];
  if (!raw.length) return { ops, bbox: { x: op.x ?? 0, y: op.y ?? 0, w: 1, h: 1 }, label: "graph (empty)" };

  // Positions: use given x/y, else arrange on a circle.
  const haveXY = raw.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
  const cx = op.x ?? 760;
  const cy = op.y ?? 320;
  const radius = Math.max(130, raw.length * 24);
  const node = raw.map((n, i) => {
    const label = (n.label ?? n.id).trim();
    const nw = Math.max(measureText(label, FONT) + 26, 46);
    let x: number;
    let y: number;
    if (haveXY) {
      x = n.x as number;
      y = n.y as number;
    } else {
      const a = (-Math.PI / 2) + (2 * Math.PI * i) / raw.length; // start at top, clockwise
      x = cx + radius * Math.cos(a);
      y = cy + radius * Math.sin(a);
    }
    return { id: n.id, label, x, y, rx: nw / 2, ry: NODE_H / 2, color: n.color };
  });
  const byId = new Map(node.map((n) => [n.id, n]));

  // Point on an ellipse boundary in the direction (dx,dy) from its centre.
  const edgePoint = (n: (typeof node)[number], dx: number, dy: number) => {
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const denom = Math.hypot(n.ry * ux, n.rx * uy) || 1;
    const r = (n.rx * n.ry) / denom;
    return { x: n.x + ux * r, y: n.y + uy * r };
  };

  // Edges (arrows) first, shortened to node boundaries.
  (op.edges ?? []).forEach((e, i) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return;
    const s = edgePoint(a, b.x - a.x, b.y - a.y);
    const t = edgePoint(b, a.x - b.x, a.y - b.y);
    ops.push({ op: "arrow", id: `${pid}.e${i}`, x: s.x, y: s.y, x2: t.x, y2: t.y, color: e.color ?? "gray" });
    const lab = (e.label ?? "").trim();
    if (lab) ops.push({ op: "text", id: `${pid}.el${i}`, x: (s.x + t.x) / 2 - measureText(lab, FONT) / 2, y: (s.y + t.y) / 2 - 9, text: lab, size: "sm", color: e.color ?? "gray" });
  });

  // Nodes on top.
  node.forEach((n, i) => {
    ops.push({ op: "ellipse", id: `${pid}.n${i}`, x: n.x - n.rx, y: n.y - n.ry, w: n.rx * 2, h: n.ry * 2, color: "black" });
    ops.push({ op: "text", id: `${pid}.t${i}`, x: n.x - measureText(n.label, FONT) / 2, y: n.y - 9, text: n.label, size: "sm", color: n.color ?? "black" });
  });

  const heading = (op.text ?? "").trim();
  const xs = node.map((n) => n.x);
  const ys = node.map((n) => n.y);
  const minX = Math.min(...xs) - 80;
  const maxX = Math.max(...xs) + 80;
  const minY = Math.min(...ys) - 40;
  const maxY = Math.max(...ys) + 40;
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x: minX + 10, y: minY - 24, text: heading, size: "md", color: "purple" });
  const bbox = { x: minX, y: minY - (heading ? 30 : 0), w: maxX - minX, h: maxY - minY + (heading ? 30 : 0) };
  return { ops, bbox, label: `graph (${node.length})` };
}
