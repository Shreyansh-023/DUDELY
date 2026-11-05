import type { DrawOp } from "../../schema";
import { flattenMath, layoutMathLine, lineHeight } from "../mathtext";
import { FONT_PX } from "../ops";
import type { Expanded } from "./util";

/**
 * Lowers a `text` op whose content uses `^`/`_` notation into one small text op
 * per run, so exponents and indices are drawn as real raised/lowered glyphs.
 *
 * This is not registered in PRIMITIVES like the diagram expanders: a `text` op
 * only routes here when it actually contains script notation (the player asks
 * `isMathText`), so ordinary prose stays a single hand-drawn element.
 *
 * Multi-line text is handled line by line; a line with no scripts still becomes
 * one run, so the whole block keeps its leading and stays one group.
 */
export function expandMathText(op: DrawOp): Expanded {
  const pid = (op.id || "mt").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 0;
  const y = op.y ?? 0;
  const basePx = FONT_PX[op.size ?? "md"];
  const color = op.color ?? "black";
  const lines = String(op.text ?? "").split("\n");

  const ops: DrawOp[] = [];
  let maxW = 0;
  let cursorY = y;

  lines.forEach((line, li) => {
    const laid = layoutMathLine(line, basePx);
    if (!laid) {
      // No scripts on this line — one ordinary text op, baseline-aligned with
      // the scripted lines around it.
      if (line.length) {
        ops.push({ op: "text", id: `${pid}.l${li}`, x, y: cursorY, text: line, size: op.size, color, temp: op.temp });
      }
      cursorY += lineHeight(basePx) + LINE_GAP;
      return;
    }
    for (const [ri, run] of laid.runs.entries()) {
      ops.push({
        op: "text",
        id: `${pid}.l${li}r${ri}`,
        x: x + run.dx,
        y: cursorY + run.dy,
        text: run.text,
        // A run is positioned in px, so it carries its own exact font size
        // rather than one of the three named sizes.
        px: run.fontPx,
        color,
        temp: op.temp,
      });
    }
    maxW = Math.max(maxW, laid.w);
    cursorY += laid.h + LINE_GAP;
  });

  const h = Math.max(cursorY - LINE_GAP - y, lineHeight(basePx));
  return {
    ops,
    bbox: { x, y, w: Math.max(maxW, 1), h },
    // The summary shows the flat form, so the model reads back what it wrote.
    label: `text "${flattenMath(lines.join(" / ")).slice(0, 60)}"`,
  };
}

/** Extra breathing room between lines of a scripted block. */
const LINE_GAP = 6;
