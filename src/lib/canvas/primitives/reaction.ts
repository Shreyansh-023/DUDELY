import type { DrawOp } from "../../schema";
import { measureText, type Expanded } from "./util";

/**
 * Lowers a `reaction` op into a chemical equation laid out horizontally:
 * reactants + reactants  →  products + products, with optional conditions above
 * and below the arrow and an optional reversible (two-way) arrow. Widths are
 * measured so the arrow and both sides never overlap.
 */

const FONT = 24; // md
const SMALL = 16;

export function expandReaction(op: DrawOp): Expanded {
  const pid = (op.id || "rxn").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 80;
  const y = op.y ?? 220;
  const left = (op.reactants ?? []).map(String).join("  +  ") || "?";
  const right = (op.products ?? []).map(String).join("  +  ") || "?";
  const over = (op.over ?? "").trim();
  const under = (op.under ?? "").trim();
  const ops: DrawOp[] = [];

  const heading = (op.text ?? "").trim();
  if (heading) ops.push({ op: "text", id: `${pid}.h`, x, y: y - 34, text: heading, size: "md", color: "purple" });

  const leftW = measureText(left, FONT);
  const rightW = measureText(right, FONT);
  const condW = Math.max(measureText(over, SMALL), measureText(under, SMALL));
  const arrowLen = Math.max(90, condW + 24);
  const textY = y;
  const arrowY = y + 14; // centre of the md text

  ops.push({ op: "text", id: `${pid}.l`, x, y: textY, text: left, size: "md", color: "black" });
  const aStart = x + leftW + 20;
  const aEnd = aStart + arrowLen;

  if (op.reversible) {
    ops.push({ op: "arrow", id: `${pid}.a1`, x: aStart, y: arrowY - 4, x2: aEnd, y2: arrowY - 4, color: "black" });
    ops.push({ op: "arrow", id: `${pid}.a2`, x: aEnd, y: arrowY + 4, x2: aStart, y2: arrowY + 4, color: "black" });
  } else {
    ops.push({ op: "arrow", id: `${pid}.a`, x: aStart, y: arrowY, x2: aEnd, y2: arrowY, color: "black" });
  }
  const mid = (aStart + aEnd) / 2;
  if (over) ops.push({ op: "text", id: `${pid}.ov`, x: mid - measureText(over, SMALL) / 2, y: arrowY - 24, text: over, size: "sm", color: "gray" });
  if (under) ops.push({ op: "text", id: `${pid}.un`, x: mid - measureText(under, SMALL) / 2, y: arrowY + 8, text: under, size: "sm", color: "gray" });

  ops.push({ op: "text", id: `${pid}.r`, x: aEnd + 20, y: textY, text: right, size: "md", color: "black" });

  const totalW = leftW + 20 + arrowLen + 20 + rightW;
  const bbox = { x: x - 8, y: y - (heading ? 44 : 28), w: totalW + 16, h: heading ? 90 : 72 };
  return { ops, bbox, label: `reaction` };
}
