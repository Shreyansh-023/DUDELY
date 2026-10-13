import type { DrawOp } from "../../schema";
import { type Expanded } from "./util";

/**
 * Lowers a `solid` op into a 3-D figure drawn in oblique projection, with hidden
 * edges / back arcs dashed. Supports cube, cuboid, cylinder, cone, sphere and
 * hemisphere. The model gives the size only; the projection geometry is here.
 */

export function expandSolid(op: DrawOp): Expanded {
  const pid = (op.id || "sol").replace(/[^a-zA-Z0-9_-]/g, "_");
  const shape = (op.shape ?? "cuboid").toLowerCase();
  const x = op.x ?? 760;
  const y = op.y ?? 180;
  const w = Math.max(op.w ?? 160, 30);
  const h = Math.max(op.h ?? (shape === "cube" ? w : 120), 30);
  const col = op.color ?? "black";
  const ops: DrawOp[] = [];
  const line = (sx: number, sy: number, ex: number, ey: number, k: string, dash = false) =>
    ops.push({ op: "line", id: `${pid}.${k}`, x: sx, y: sy, x2: ex, y2: ey, color: col, dash });
  // Elliptical arc as short segments (used for round bases/equators).
  const arc = (cx: number, cy: number, rx: number, ry: number, t0: number, t1: number, k: string, dash: boolean) => {
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a0 = t0 + ((t1 - t0) * i) / n;
      const a1 = t0 + ((t1 - t0) * (i + 1)) / n;
      line(cx + rx * Math.cos(a0), cy + ry * Math.sin(a0), cx + rx * Math.cos(a1), cy + ry * Math.sin(a1), `${k}${i}`, dash);
    }
  };

  const heading = (op.text ?? "").trim();
  const title = (hy: number) => {
    if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: hy, text: heading, size: "md", color: "purple" });
  };

  if (shape === "cylinder") {
    const eh = Math.max(w * 0.28, 12);
    const rx = w / 2;
    const ry = eh / 2;
    ops.push({ op: "ellipse", id: `${pid}.top`, x, y, w, h: eh, color: col });
    line(x, y + ry, x, y + h + ry, "sL");
    line(x + w, y + ry, x + w, y + h + ry, "sR");
    arc(x + rx, y + h + ry, rx, ry, 0, Math.PI, "bf", false); // base front (lower), solid
    arc(x + rx, y + h + ry, rx, ry, Math.PI, 2 * Math.PI, "bb", true); // base back (upper), dashed
    title(y - 34);
    return { ops, bbox: { x: x - 10, y: y - (heading ? 40 : 10), w: w + 20, h: h + eh + (heading ? 54 : 24) }, label: "cylinder" };
  }

  if (shape === "cone") {
    const eh = Math.max(w * 0.28, 12);
    const rx = w / 2;
    const ry = eh / 2;
    const apex = { x: x + rx, y };
    const baseCy = y + h;
    arc(x + rx, baseCy, rx, ry, 0, Math.PI, "bf", false); // base front, solid
    arc(x + rx, baseCy, rx, ry, Math.PI, 2 * Math.PI, "bb", true); // base back, dashed
    line(apex.x, apex.y, x, baseCy, "sL"); // slant sides to the base's widest points
    line(apex.x, apex.y, x + w, baseCy, "sR");
    title(y - 34);
    return { ops, bbox: { x: x - 10, y: y - (heading ? 40 : 10), w: w + 20, h: h + ry + (heading ? 54 : 24) }, label: "cone" };
  }

  if (shape === "sphere" || shape === "hemisphere") {
    const rx = w / 2;
    const cx = x + rx;
    if (shape === "sphere") {
      const cy = y + rx;
      ops.push({ op: "ellipse", id: `${pid}.out`, x, y, w, h: w, color: col }); // outline circle
      // Equator ellipse: front (lower) solid, back (upper) dashed.
      const ery = Math.max(rx * 0.3, 10);
      arc(cx, cy, rx, ery, 0, Math.PI, "ef", false);
      arc(cx, cy, rx, ery, Math.PI, 2 * Math.PI, "eb", true);
      title(y - 34);
      return { ops, bbox: { x: x - 10, y: y - (heading ? 40 : 10), w: w + 20, h: w + (heading ? 54 : 24) }, label: "sphere" };
    }
    // Hemisphere: top dome (upper semicircle) + flat base ellipse.
    const ery = Math.max(rx * 0.3, 10);
    arc(cx, y + 0, rx, rx, Math.PI, 2 * Math.PI, "dome", false); // upper semicircle (dome)
    arc(cx, y + 0, rx, ery, 0, Math.PI, "bf", false); // base front, solid
    arc(cx, y + 0, rx, ery, Math.PI, 2 * Math.PI, "bb", true); // base back, dashed
    title(y - rx - 34);
    return { ops, bbox: { x: x - 10, y: y - rx - (heading ? 44 : 12), w: w + 20, h: rx + ery + (heading ? 54 : 24) }, label: "hemisphere" };
  }

  if (shape === "frustum") {
    const eh = Math.max(w * 0.28, 12);
    const rx = w / 2;
    const w2 = Math.max(Math.min(op.w2 ?? w * 0.55, w - 10), 20);
    const rx2 = w2 / 2;
    const topCx = x + rx;
    ops.push({ op: "ellipse", id: `${pid}.top`, x: topCx - rx2, y, w: w2, h: eh, color: col }); // top rim
    arc(x + rx, y + h, rx, eh / 2, 0, Math.PI, "bf", false); // base front
    arc(x + rx, y + h, rx, eh / 2, Math.PI, 2 * Math.PI, "bb", true); // base back dashed
    line(topCx - rx2, y + eh / 2, x, y + h, "sL");
    line(topCx + rx2, y + eh / 2, x + w, y + h, "sR");
    title(y - 34);
    return { ops, bbox: { x: x - 10, y: y - (heading ? 40 : 10), w: w + 20, h: h + eh / 2 + (heading ? 54 : 24) }, label: "frustum" };
  }

  if (shape === "prism") {
    const o2 = Math.min(op.d ?? w * 0.5, 120) * 0.5;
    const ox2 = o2;
    const oy2 = -o2;
    const apex = { x: x + w / 2, y };
    const bL = { x, y: y + h };
    const bR = { x: x + w, y: y + h };
    const Bk = (p: { x: number; y: number }) => ({ x: p.x + ox2, y: p.y + oy2 });
    const kApex = Bk(apex);
    const kbL = Bk(bL);
    const kbR = Bk(bR);
    // Front triangle (solid).
    line(apex.x, apex.y, bL.x, bL.y, "f1");
    line(bL.x, bL.y, bR.x, bR.y, "f2");
    line(bR.x, bR.y, apex.x, apex.y, "f3");
    // Visible connectors + back edge.
    line(apex.x, apex.y, kApex.x, kApex.y, "cA");
    line(bR.x, bR.y, kbR.x, kbR.y, "cR");
    line(kApex.x, kApex.y, kbR.x, kbR.y, "kR");
    // Hidden (dashed).
    line(kApex.x, kApex.y, kbL.x, kbL.y, "hA", true);
    line(kbL.x, kbL.y, kbR.x, kbR.y, "hB", true);
    line(bL.x, bL.y, kbL.x, kbL.y, "hL", true);
    title(y + oy2 - 34);
    return { ops, bbox: { x: x - 10, y: y + oy2 - (heading ? 44 : 10), w: w + ox2 + 20, h: h - oy2 + (heading ? 54 : 20) }, label: "prism" };
  }

  // Cuboid / cube: front face + depth offset.
  const off = Math.min(shape === "cube" ? Math.min(w, h) : op.d ?? w * 0.5, 120) * 0.5;
  const ox = off;
  const oy = -off;
  const fTL = { x, y };
  const fTR = { x: x + w, y };
  const fBR = { x: x + w, y: y + h };
  const fBL = { x, y: y + h };
  const B = (p: { x: number; y: number }) => ({ x: p.x + ox, y: p.y + oy });
  const bTL = B(fTL);
  const bTR = B(fTR);
  const bBR = B(fBR);
  const bBL = B(fBL);
  // Front face (solid).
  line(fTL.x, fTL.y, fTR.x, fTR.y, "f1");
  line(fTR.x, fTR.y, fBR.x, fBR.y, "f2");
  line(fBR.x, fBR.y, fBL.x, fBL.y, "f3");
  line(fBL.x, fBL.y, fTL.x, fTL.y, "f4");
  // Visible back + connectors (solid).
  line(bTL.x, bTL.y, bTR.x, bTR.y, "kTop");
  line(bTR.x, bTR.y, bBR.x, bBR.y, "kRight");
  line(fTL.x, fTL.y, bTL.x, bTL.y, "cTL");
  line(fTR.x, fTR.y, bTR.x, bTR.y, "cTR");
  line(fBR.x, fBR.y, bBR.x, bBR.y, "cBR");
  // Hidden rear edges (dashed).
  line(bTL.x, bTL.y, bBL.x, bBL.y, "hL", true);
  line(bBL.x, bBL.y, bBR.x, bBR.y, "hB", true);
  line(fBL.x, fBL.y, bBL.x, bBL.y, "hC", true);
  title(y + oy - 34);
  const bbox = { x: x - 10, y: y + oy - (heading ? 44 : 10), w: w + ox + 20, h: h - oy + (heading ? 54 : 20) };
  return { ops, bbox, label: shape === "cube" ? "cube" : "cuboid" };
}
