import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `tree` op into a top-down tree with a tidy layout computed in code:
 * leaves are spread evenly left-to-right and each parent is centred over its
 * children, so edges never cross siblings and labels never overlap. Edge labels
 * (e.g. probabilities) sit at the midpoint of each line. Works for factor trees,
 * probability trees and classification trees.
 */

const FONT = 16;
const Y_GAP = 82;

type Node = { id: string; label: string; parent: string | null; edge: string; color: DrawOp["color"] };

export function expandTree(op: DrawOp): Expanded {
  const pid = (op.id || "tree").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x0 = op.x ?? 120;
  const y0 = op.y ?? 160;
  const raw = (op.nodes ?? []).filter((n) => n && n.id);
  const nodes: Node[] = raw.map((n) => ({ id: n.id, label: (n.label ?? n.id).trim(), parent: (n.parent ?? null) as string | null, edge: (n.edge ?? "").trim(), color: n.color }));
  const ops: DrawOp[] = [];
  if (!nodes.length) return { ops, bbox: { x: x0, y: y0, w: 1, h: 1 }, label: "tree (empty)" };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, Node[]>();
  for (const n of nodes) {
    const p = n.parent && byId.has(n.parent) ? n.parent : null;
    n.parent = p;
    if (p) (kids.get(p) ?? kids.set(p, []).get(p)!).push(n);
  }
  const roots = nodes.filter((n) => !n.parent);

  const xGap = Math.max(...nodes.map((n) => measureText(n.label, FONT)), 40) + 30;
  const col = new Map<string, number>();
  const depth = new Map<string, number>();
  let leafCounter = 0;
  const seen = new Set<string>();
  const assign = (id: string, d: number): number => {
    if (seen.has(id)) return col.get(id) ?? leafCounter++; // cycle guard
    seen.add(id);
    depth.set(id, d);
    const cs = kids.get(id) ?? [];
    let c: number;
    if (!cs.length) c = leafCounter++;
    else c = cs.map((k) => assign(k.id, d + 1)).reduce((a, b) => a + b, 0) / cs.length;
    col.set(id, c);
    return c;
  };
  roots.forEach((r) => assign(r.id, 0));

  const px = (id: string) => x0 + (col.get(id) ?? 0) * xGap;
  const py = (id: string) => y0 + (depth.get(id) ?? 0) * Y_GAP;

  // Edges first (so node labels sit on top).
  nodes.forEach((n, i) => {
    if (!n.parent) return;
    const cxp = px(n.parent);
    const cyp = py(n.parent) + 10;
    const cxc = px(n.id);
    const cyc = py(n.id) - 10;
    ops.push({ op: "line", id: `${pid}.e${i}`, x: cxp, y: cyp, x2: cxc, y2: cyc, color: "gray" });
    if (n.edge) {
      ops.push({ op: "text", id: `${pid}.el${i}`, x: (cxp + cxc) / 2 - measureText(n.edge, FONT) / 2, y: (cyp + cyc) / 2 - 9, text: n.edge, size: "sm", color: "gray" });
    }
  });
  // Node labels.
  nodes.forEach((n, i) => {
    ops.push({ op: "text", id: `${pid}.n${i}`, x: px(n.id) - measureText(n.label, FONT) / 2, y: py(n.id) - 9, text: n.label, size: "sm", color: n.color ?? "black" });
  });

  const xs = nodes.map((n) => px(n.id));
  const ys = nodes.map((n) => py(n.id));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const bbox = { x: minX - 40, y: Math.min(...ys) - 24, w: maxX - minX + 80, h: Math.max(...ys) - Math.min(...ys) + 48 };
  return { ops, bbox, label: `tree (${nodes.length})` };
}
