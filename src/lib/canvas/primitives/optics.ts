import type { DrawOp } from "../../schema";
import { clamp } from "../../utils";
import { measureText, type Expanded } from "./util";

/**
 * Lowers an `optics` op into a ray diagram for a lens or mirror. The image
 * position/size come from the thin-lens / mirror equation under the New Cartesian
 * sign convention (object on the left, u = -objectAt; f: +|f| for a convex lens /
 * convex mirror, -|f| for a concave lens / concave mirror). Two principal rays
 * are drawn to the computed image. Verified against standard cases (object at 2F
 * -> image at 2F, inverted, same size).
 *
 * Note: virtual images are drawn with solid (not dashed) construction lines —
 * good enough schematically; a later pass can dash back-projections.
 */

const FONT = 16;
const LH = 64; // half-height of the device symbol

function fSign(device: string): number {
  // convex lens & convex mirror -> +|f|; concave lens & concave mirror -> -|f|.
  return device.includes("convex") ? 1 : -1;
}

export function expandOptics(op: DrawOp): Expanded {
  const pid = (op.id || "opt").replace(/[^a-zA-Z0-9_-]/g, "_");
  const device = (op.device ?? "convex-lens").toLowerCase();
  const isLens = device.includes("lens");
  const dx = op.x ?? 900; // device x (optical centre / pole)
  const ay = op.y ?? 280; // principal axis y
  const F = Math.max(Math.abs(op.f ?? 6), 0.5);
  const objAt = Math.max(Math.abs(op.objectAt ?? 2 * F), 0.1);
  const objH = Math.max(Math.abs(op.objectH ?? 2), 0.1);
  const scale = clamp(op.scale ?? 180 / Math.max(objAt, 1), 6, 30);
  const col = op.color ?? "black";
  const f = fSign(device) * F;
  const u = -objAt;
  const invV = isLens ? 1 / f + 1 / u : 1 / f - 1 / u;
  const v = Math.abs(invV) < 1e-6 ? Infinity : 1 / invV;
  const m = isLens ? v / u : -v / u;
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  const objX = dx - objAt * scale;
  const objTop = ay - objH * scale;
  const finiteImg = Number.isFinite(v) && Math.abs(v * scale) < 1200;
  const imgX = dx + v * scale;
  const imgTop = ay - m * objH * scale;

  // Principal axis.
  const left = Math.min(objX, finiteImg ? imgX : objX, dx - 2 * F * scale) - 36;
  const right = Math.max(objX, finiteImg ? imgX : dx, dx + 2 * F * scale) + 36;
  ops.push({ op: "line", id: `${pid}.axis`, x: left, y: ay, x2: right, y2: ay, color: col });
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x: left, y: ay - LH - 36, text: heading, size: "md", color: "purple" });

  // Device symbol.
  ops.push({ op: "line", id: `${pid}.dev`, x: dx, y: ay - LH, x2: dx, y2: ay + LH, color: col });
  if (isLens) {
    const out = device.includes("convex") ? 1 : -1; // convex: arrows out; concave: in
    ops.push({ op: "arrow", id: `${pid}.t1`, x: dx, y: ay - LH + 14 * out, x2: dx, y2: ay - LH, color: col });
    ops.push({ op: "arrow", id: `${pid}.t2`, x: dx, y: ay + LH - 14 * out, x2: dx, y2: ay + LH, color: col });
  } else {
    for (let i = -3; i <= 3; i++) {
      const yy = ay + (i * LH) / 3.5;
      ops.push({ op: "line", id: `${pid}.ht${i}`, x: dx, y: yy, x2: dx + 10, y2: yy - 10, color: col });
    }
  }

  // Focus / 2F (or centre of curvature) marks on the axis.
  const mark = (px: number, t: string, k: string) => {
    ops.push({ op: "line", id: `${pid}.mk${k}`, x: px, y: ay - 5, x2: px, y2: ay + 5, color: "gray" });
    ops.push({ op: "text", id: `${pid}.ml${k}`, x: px - measureText(t, FONT) / 2, y: ay + 8, text: t, size: "sm", color: "gray" });
  };
  if (isLens) {
    mark(dx - F * scale, "F", "fl");
    mark(dx + F * scale, "F", "fr");
    mark(dx - 2 * F * scale, "2F", "2fl");
    mark(dx + 2 * F * scale, "2F", "2fr");
  } else {
    mark(dx - F * scale, "F", "f");
    mark(dx - 2 * F * scale, "C", "c");
  }

  // Object (blue upright arrow).
  ops.push({ op: "arrow", id: `${pid}.obj`, x: objX, y: ay, x2: objX, y2: objTop, color: "blue" });
  ops.push({ op: "text", id: `${pid}.objl`, x: objX - 6, y: objTop - 20, text: "O", size: "sm", color: "blue" });

  // Virtual image: lens image on the object side (v<0), or mirror image behind it (v>0).
  const virtual = isLens ? v < 0 : v > 0;
  if (finiteImg) {
    // Two principal rays. Before the device they are solid; the segments that reach
    // a VIRTUAL image are back-projections, so they are drawn dashed (textbook style).
    ops.push({ op: "line", id: `${pid}.rA1`, x: objX, y: objTop, x2: dx, y2: objTop, color: "orange" });
    ops.push({ op: "line", id: `${pid}.rA2`, x: dx, y: objTop, x2: imgX, y2: imgTop, color: "orange", dash: virtual });
    ops.push({ op: "line", id: `${pid}.rB1`, x: objX, y: objTop, x2: dx, y2: ay, color: "purple" });
    ops.push({ op: "line", id: `${pid}.rB2`, x: dx, y: ay, x2: imgX, y2: imgTop, color: "purple", dash: virtual });
    // Image (green arrow — up if erect, down if inverted; dashed if virtual).
    ops.push({ op: "arrow", id: `${pid}.img`, x: imgX, y: ay, x2: imgX, y2: imgTop, color: "green", dash: virtual });
    ops.push({ op: "text", id: `${pid}.imgl`, x: imgX - 4, y: imgTop + (imgTop < ay ? -20 : 8), text: "I", size: "sm", color: "green" });
  } else {
    // Image at infinity: show the parallel emergent ray instead.
    ops.push({ op: "line", id: `${pid}.rA1`, x: objX, y: objTop, x2: dx, y2: objTop, color: "orange" });
    ops.push({ op: "arrow", id: `${pid}.rA2`, x: dx, y: objTop, x2: right, y2: objTop, color: "orange" });
  }

  const top = Math.min(ay - LH, objTop, finiteImg ? imgTop : ay) - (heading ? 40 : 14);
  const bottom = Math.max(ay + LH, finiteImg ? imgTop : ay) + 22;
  const bbox = { x: left - 8, y: top, w: right - left + 16, h: bottom - top };
  return { ops, bbox, label: `optics ${device}` };
}
