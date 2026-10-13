import type { DrawOp } from "../../schema";
import { type Expanded } from "./util";

/**
 * Lowers a `net` op into the unfolded faces of a cuboid (or cube) laid out as a
 * cross: top above the front, bottom below it, and left/front/right/back in a
 * row. Each face is a labelled rectangle sized to the real dimensions, so a
 * surface-area lesson can see every face without overlap.
 *
 *   dims: front/back = w x h, left/right = d x h, top/bottom = w x d.
 */

export function expandNet(op: DrawOp): Expanded {
  const pid = (op.id || "net").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 120;
  const y = op.y ?? 160;
  const cube = (op.shape ?? "cuboid").toLowerCase() === "cube";
  const w = Math.max(op.w ?? 120, 30);
  const h = Math.max(cube ? w : op.h ?? 120, 30);
  const d = Math.max(cube ? w : op.d ?? 90, 30);
  const col = op.color ?? "black";
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 34, text: heading, size: "md", color: "purple" });

  const face = (fx: number, fy: number, fw: number, fh: number, label: string, k: string) =>
    ops.push({ op: "rect", id: `${pid}.${k}`, x: fx, y: fy, w: fw, h: fh, text: label, color: col });

  // Cross layout. Middle row (height h): left(d) | front(w) | right(d) | back(w).
  const midY = y + d; // top face occupies height d above the middle row
  face(x + d, y, w, d, "Top", "top");
  face(x, midY, d, h, "Left", "left");
  face(x + d, midY, w, h, "Front", "front");
  face(x + d + w, midY, d, h, "Right", "right");
  face(x + d + w + d, midY, w, h, "Back", "back");
  face(x + d, midY + h, w, d, "Bottom", "bottom");

  const totalW = d + w + d + w;
  const totalH = d + h + d;
  const bbox = { x: x - 8, y: y - (heading ? 44 : 8), w: totalW + 16, h: totalH + (heading ? 52 : 16) };
  return { ops, bbox, label: cube ? "net (cube)" : "net (cuboid)" };
}
