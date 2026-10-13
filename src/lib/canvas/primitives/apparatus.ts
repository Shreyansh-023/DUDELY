import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers an `apparatus` op into lab glassware/equipment symbols drawn at the
 * positions the model gives (x,y = the item's top-left). Each item is a small
 * hand-drawn vessel with a label beneath it. Connect items with free-form line
 * ops (delivery tubes) if needed. Supports the common NCERT apparatus.
 */

const FONT = 16;

function vessel(type: string, x: number, y: number, pid: string, i: number): { ops: DrawOp[]; w: number; h: number } {
  const t = type.toLowerCase();
  const o: DrawOp[] = [];
  const L = (sx: number, sy: number, ex: number, ey: number, k: string) =>
    o.push({ op: "line", id: `${pid}.i${i}_${k}`, x: sx, y: sy, x2: ex, y2: ey, color: "black" });
  const arc = (cx: number, cy: number, rx: number, ry: number, t0: number, t1: number, k: string) => {
    const n = 10;
    for (let s = 0; s < n; s++) {
      const a0 = t0 + ((t1 - t0) * s) / n;
      const a1 = t0 + ((t1 - t0) * (s + 1)) / n;
      L(cx + rx * Math.cos(a0), cy + ry * Math.sin(a0), cx + rx * Math.cos(a1), cy + ry * Math.sin(a1), `${k}${s}`);
    }
  };
  if (t === "beaker") {
    const w = 54, h = 70;
    L(x, y, x + 6, y, "lip"); // small spout lip
    L(x, y, x, y + h, "lft");
    L(x + w, y, x + w, y + h, "rgt");
    L(x, y + h, x + w, y + h, "bot");
    return { ops: o, w, h };
  }
  if (t === "testtube") {
    const w = 22, h = 80;
    L(x, y, x, y + h - w / 2, "lft");
    L(x + w, y, x + w, y + h - w / 2, "rgt");
    arc(x + w / 2, y + h - w / 2, w / 2, w / 2, 0, Math.PI, "u"); // rounded bottom
    return { ops: o, w, h };
  }
  if (t === "flask") {
    // Conical (Erlenmeyer): narrow neck, wide base.
    const w = 64, h = 78, neck = 16;
    L(x + w / 2 - neck / 2, y, x + w / 2 - neck / 2, y + 18, "nl");
    L(x + w / 2 + neck / 2, y, x + w / 2 + neck / 2, y + 18, "nr");
    L(x + w / 2 - neck / 2, y + 18, x, y + h, "sl");
    L(x + w / 2 + neck / 2, y + 18, x + w, y + h, "sr");
    L(x, y + h, x + w, y + h, "bot");
    return { ops: o, w, h };
  }
  if (t === "roundflask") {
    const r = 28, neck = 14;
    o.push({ op: "ellipse", id: `${pid}.i${i}_b`, x: x, y: y + 20, w: r * 2, h: r * 2, color: "black" });
    L(x + r - neck / 2, y, x + r - neck / 2, y + 22, "nl");
    L(x + r + neck / 2, y, x + r + neck / 2, y + 22, "nr");
    return { ops: o, w: r * 2, h: r * 2 + 20 };
  }
  if (t === "funnel") {
    const w = 50, h = 60;
    L(x, y, x + w, y, "top");
    L(x, y, x + w / 2 - 4, y + 34, "sl");
    L(x + w, y, x + w / 2 + 4, y + 34, "sr");
    L(x + w / 2 - 4, y + 34, x + w / 2 - 4, y + h, "tl");
    L(x + w / 2 + 4, y + 34, x + w / 2 + 4, y + h, "tr");
    return { ops: o, w, h };
  }
  if (t === "thermometer") {
    const w = 12, h = 90;
    L(x + w / 2, y, x + w / 2, y + h - 8, "stem");
    o.push({ op: "ellipse", id: `${pid}.i${i}_bulb`, x, y: y + h - 14, w, h: 14, color: "red" });
    return { ops: o, w, h };
  }
  // stand (retort): base + rod + a short clamp arm.
  const w = 70, h = 110;
  L(x, y + h, x + w * 0.7, y + h, "base");
  L(x + 10, y + h, x + 10, y, "rod");
  L(x + 10, y + 20, x + w, y + 20, "arm");
  return { ops: o, w, h };
}

export function expandApparatus(op: DrawOp): Expanded {
  const pid = (op.id || "app").replace(/[^a-zA-Z0-9_-]/g, "_");
  const items = (op.items ?? []).filter((it) => it && it.type && Number.isFinite(it.x) && Number.isFinite(it.y));
  const ops: DrawOp[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  items.forEach((it, i) => {
    const { ops: vo, w, h } = vessel(it.type, it.x, it.y, pid, i);
    ops.push(...vo);
    const label = (it.label ?? "").trim();
    if (label) ops.push({ op: "text", id: `${pid}.l${i}`, x: it.x + w / 2 - measureText(label, FONT) / 2, y: it.y + h + 6, text: label, size: "sm", color: "black" });
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + w);
    maxY = Math.max(maxY, it.y + h + (label ? 22 : 0));
  });

  const heading = (op.text ?? "").trim();
  if (items.length && heading) ops.push({ op: "text", id: `${pid}.h`, x: minX, y: minY - 30, text: heading, size: "md", color: "purple" });
  const bbox = items.length
    ? { x: minX - 10, y: minY - (heading ? 36 : 10), w: maxX - minX + 20, h: maxY - minY + (heading ? 46 : 20) }
    : { x: op.x ?? 0, y: op.y ?? 0, w: 1, h: 1 };
  return { ops, bbox, label: `apparatus (${items.length})` };
}
