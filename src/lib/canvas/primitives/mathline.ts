import type { DrawOp } from "../../schema";
import { flattenMath, layoutMathLine, lineHeight } from "../mathtext";
import { FONT_PX, needsMathFont } from "../ops";
import type { Expanded } from "./util";

/**
 * Lowers a `text` op whose content uses `^`/`_`/`√` notation into one small
 * text op per run plus a line op per radical stroke, so exponents, indices and
 * square roots are drawn as real raised/lowered glyphs and hand-drawn signs.
 *
 * This is not registered in PRIMITIVES like the diagram expanders: a `text` op
 * only routes here when it actually contains notation (the player asks
 * `hasMathNotation`), so ordinary prose stays a single hand-drawn element.
 *
 * Multi-line text is handled line by line; a line with no notation still
 * becomes one run, so the whole block keeps its leading and stays one group.
 */
export function expandMathText(op: DrawOp): Expanded {
  const pid = (op.id || "mt").replace(/[^a-zA-Z0-9_-]/g, "_");
  const x = op.x ?? 0;
  const y = op.y ?? 0;
  const basePx = op.px ?? FONT_PX[op.size ?? "md"];
  const color = op.color ?? "black";
  const lines = String(op.text ?? "").split("\n");

  const ops: DrawOp[] = [];
  let maxW = 0;
  let cursorY = y;
  let overhang = 0;

  lines.forEach((line, li) => {
    // A line that needs a glyph the hand font lacks (≤, →, ∞ …) is drawn in
    // the fallback font, so its runs are measured in that font's widths.
    const math = needsMathFont(line);
    const laid = layoutMathLine(line, basePx, math);
    if (!laid) {
      // No notation on this line — one ordinary text op, baseline-aligned with
      // the scripted lines around it.
      if (line.length) {
        ops.push({ op: "text", id: `${pid}.l${li}`, x, y: cursorY, text: line, size: op.size, px: op.px, color, temp: op.temp });
      }
      cursorY += lineHeight(basePx) + LINE_GAP;
      return;
    }
    // The BASE runs sit where a plain line would; a superscript rises above
    // that into the line gap. Measuring the block from the superscript's top
    // dropped every scripted line a few pixels and made the leading uneven.
    const baseRuns = laid.runs.filter((r) => r.level === "base");
    const baseTop = baseRuns.length ? Math.min(...baseRuns.map((r) => r.dy)) : 0;
    overhang = Math.max(overhang, baseTop);
    for (const [ri, run] of laid.runs.entries()) {
      ops.push({
        op: "text",
        id: `${pid}.l${li}r${ri}`,
        x: x + run.dx,
        y: cursorY + run.dy - baseTop,
        text: run.text,
        // A run is positioned in px, so it carries its own exact font size
        // rather than one of the three named sizes.
        px: run.fontPx,
        font: math ? "math" : undefined,
        color,
        temp: op.temp,
      });
    }
    for (const [si, s] of laid.strokes.entries()) {
      ops.push({
        op: "line",
        id: `${pid}.l${li}s${si}`,
        x: x + s.x1,
        y: cursorY + s.y1 - baseTop,
        x2: x + s.x2,
        y2: cursorY + s.y2 - baseTop,
        color,
        temp: op.temp,
      });
    }
    maxW = Math.max(maxW, laid.w);
    // Every line advances by the same pitch, scripted or not.
    cursorY += Math.max(lineHeight(basePx), laid.h - baseTop) + LINE_GAP;
  });

  const h = Math.max(cursorY - LINE_GAP - y, lineHeight(basePx));
  return {
    ops,
    bbox: { x, y: y - overhang, w: Math.max(maxW, 1), h: h + overhang },
    // The summary shows the flat form, so the model reads back what it wrote.
    label: `text "${flattenMath(lines.join(" / ")).slice(0, 60)}"`,
  };
}

/** Extra breathing room between lines of a scripted block. */
const LINE_GAP = 6;
