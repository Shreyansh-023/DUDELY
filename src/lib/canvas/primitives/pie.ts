import type { ColorName, DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `pie` op into a pie chart: a circle divided by radii at each slice
 * boundary (angle proportional to value), with each slice's label and percentage
 * placed just outside the rim at the slice's mid-angle. Reuses the `data` field.
 * (Slices are outlined, not filled — the hand-drawn primitives can't fill an arc
 * sector — but the colour is carried on each radius and label.)
 */

const FONT = 16;
const PALETTE: ColorName[] = ["blue", "green", "orange", "purple", "red", "gray"];

export function expandPie(op: DrawOp): Expanded {
  const pid = (op.id || "pie").replace(/[^a-zA-Z0-9_-]/g, "_");
  const cx = op.x ?? 820;
  const cy = op.y ?? 300;
  const r = Math.max((op.w ?? 180) / 2, 50);
  const data = (op.data ?? []).filter((d) => d && Number.isFinite(d.value) && d.value > 0);
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x: cx - r, y: cy - r - 40, text: heading, size: "md", color: "purple" });

  // The circle.
  ops.push({ op: "ellipse", id: `${pid}.circ`, x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, color: "black" });
  if (!data.length) return { ops, bbox: { x: cx - r - 20, y: cy - r - 20, w: 2 * r + 40, h: 2 * r + 40 }, label: "pie (empty)" };

  const total = data.reduce((s, d) => s + d.value, 0);
  let a0 = -Math.PI / 2; // start at top
  data.forEach((d, i) => {
    const span = (d.value / total) * 2 * Math.PI;
    const a1 = a0 + span;
    const color = d.color ?? PALETTE[i % PALETTE.length];
    // Boundary radius at the start of the slice.
    ops.push({ op: "line", id: `${pid}.r${i}`, x: cx, y: cy, x2: cx + r * Math.cos(a0), y2: cy + r * Math.sin(a0), color });
    // Label + percentage outside the rim at the mid-angle.
    const mid = (a0 + a1) / 2;
    const pct = Math.round((d.value / total) * 100);
    const t = `${(d.label ?? "").trim()} ${pct}%`.trim();
    const lx = cx + (r + 16) * Math.cos(mid);
    const ly = cy + (r + 16) * Math.sin(mid);
    const anchored = Math.cos(mid) < 0 ? lx - measureText(t, FONT) : lx; // left of point on the left side
    ops.push({ op: "text", id: `${pid}.l${i}`, x: anchored, y: ly - 9, text: t, size: "sm", color });
    a0 = a1;
  });

  const bbox = { x: cx - r - 90, y: cy - r - (heading ? 46 : 24), w: 2 * r + 180, h: 2 * r + (heading ? 70 : 48) };
  return { ops, bbox, label: `pie (${data.length})` };
}
