import type { DrawOp } from "../../schema";
import { fmt, measureText, type Expanded } from "./util";

/**
 * Lowers a `timeline` op into a horizontal arrow with events placed by value;
 * each event's value sits just below its tick and its label above, at staggered
 * heights (with a leader line) so neighbouring labels don't collide. Reuses the
 * `marks` field. Use for history, sequences of events, process stages.
 */

const FONT = 16;

export function expandTimeline(op: DrawOp): Expanded {
  const pid = (op.id || "tl").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 120;
  const y = op.y ?? 260;
  const w = Math.max(op.w ?? 760, 160);
  const events = (op.marks ?? []).filter((m) => m && Number.isFinite(m.at)).sort((a, b) => a.at - b.at);
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 76, text: heading, size: "md", color: "purple" });

  // The line (arrow pointing forward in time).
  ops.push({ op: "arrow", id: `${pid}.axis`, x, y, x2: x + w, y2: y, color: "black" });
  if (!events.length) return { ops, bbox: { x: x - 10, y: y - 20, w: w + 30, h: 60 }, label: "timeline (empty)" };

  const ats = events.map((e) => e.at);
  const min = op.min ?? Math.min(...ats);
  const max = op.max ?? Math.max(...ats);
  const span = max - min || 1;
  const toPx = (v: number) => x + ((v - min) / span) * w;

  events.forEach((e, i) => {
    const px = toPx(e.at);
    const color = e.color ?? "blue";
    ops.push({ op: "line", id: `${pid}.t${i}`, x: px, y: y - 5, x2: px, y2: y + 5, color: "black" });
    // Value below the tick.
    const val = fmt(e.at);
    ops.push({ op: "text", id: `${pid}.v${i}`, x: px - measureText(val, FONT) / 2, y: y + 10, text: val, size: "sm", color: "gray" });
    // Event label above, staggered so neighbours sit at different heights.
    const label = (e.label ?? "").trim();
    if (label) {
      const up = 26 + (i % 2) * 26;
      ops.push({ op: "line", id: `${pid}.c${i}`, x: px, y, x2: px, y2: y - up, color: "gray" });
      ops.push({ op: "text", id: `${pid}.l${i}`, x: px - measureText(label, FONT) / 2, y: y - up - 18, text: label, size: "sm", color });
    }
  });

  const bbox = { x: x - 20, y: y - (heading ? 86 : 72), w: w + 50, h: heading ? 120 : 106 };
  return { ops, bbox, label: `timeline (${events.length})` };
}
