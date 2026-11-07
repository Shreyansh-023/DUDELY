import type { DrawOp } from "../schema";
import { FONT_PX } from "./ops";
import { hasMathNotation } from "./mathtext";
import { CLEARANCE, CONTENT_BOTTOM, CONTENT_LEFT, CONTENT_RIGHT, CONTENT_TOP, MD_PITCH } from "./page";

/**
 * The flow layout engine: where everything on a page goes.
 *
 * The model never chooses page positions. It writes a beat's ops in reading
 * order and this module places them the way a document is set: text lines go
 * down the notes column one under the other; a narrow figure floats to the
 * right of the lines that introduce it and the text wraps beside it; a wide
 * figure takes the full width below the text; two narrow figures in one beat sit
 * side by side; a page that fills up continues on a fresh one, and a figure too
 * tall for a fresh page is drawn smaller rather than spilled. Because the
 * cursor only ever moves past what has been placed, two things can never land on
 * each other — no nudging, no repair pass, nothing for a model to get wrong.
 *
 * Pure and DOM-free: measuring is injected (`measure`), geometry is page-local,
 * and the result is a list of placements the player turns into elements. The
 * regression script runs it under plain node.
 */

export type Rect = { x: number; y: number; w: number; h: number };

/** Column the notes flow down. */
export const COL_W = CONTENT_RIGHT - CONTENT_LEFT;
/** A figure at most this wide floats beside the notes instead of under them. */
export const FLOAT_MAX_W = 560;
/** Air between a float and the text wrapping beside it, and between two figures in a row. */
export const FLOAT_GAP = 36;
/** Text is never squeezed into a strip narrower than this beside a float. */
export const MIN_TEXT_W = 420;
/** Vertical air after a text block: an md line (30px) then lands on the 50px pitch the board always used. */
export const TEXT_GAP = MD_PITCH - Math.round(FONT_PX.md * 1.25);
/** Extra leading between the lines of a scripted (superscript) block. */
export const MATH_LINE_GAP = 6;
/** Smallest factor a figure is shrunk by to fit a fresh page. Below this it is
 *  drawn at this size and allowed to run long: a figure a third of its size is
 *  no longer the figure. */
export const MIN_SCALE = 0.55;
/** A figure that fits the room left on the CURRENT page at this scale or more
 *  is shrunk into it rather than sent to a fresh page: a page left two-thirds
 *  empty under three lines of notes is the worse layout. */
export const KEEP_SCALE = 0.7;
/** A figure (or pair) wider than the float column still floats beside the
 *  notes when shrinking it this much brings it in: a smaller diagram with its
 *  explanation beside it beats a full-width one that pushes the words to the
 *  next page. Labels keep their size, so 60% is still legible. */
export const FLOAT_SHRINK = 0.6;
/** A sketch drawn this close to the turn's earlier sketch is part of it. */
export const FRAME_REACH = 80;
/** A text block may split across pages only if at least this many lines stay on each side. */
const MIN_SPLIT_LINES = 2;
/** How many text lines a beat may already have placed on a page before a figure
 *  that does not fit stops dragging the whole beat onto the next page. */
const KEEP_WITH_NEXT_LINES = 3;

// ---------------------------------------------------------------------------
// Classification: what kind of thing each op is, before any measuring.
// ---------------------------------------------------------------------------

/** Diagram ops whose geometry is self-contained: placed as one block. */
const FIGURE_OPS: ReadonlySet<string> = new Set([
  "numberline",
  "axes",
  "bars",
  "fraction",
  "polygon",
  "vector",
  "table",
  "circles",
  "circuit",
  "optics",
  "molecule",
  "solid",
  "punnett",
  "net",
  "reaction",
  "tree",
  "venn",
  "graph",
  "apparatus",
  "wave",
  "pie",
  "incline",
  "timeline",
]);

/** Free-form ops whose coordinates only mean something relative to each other. */
const SKETCH_OPS: ReadonlySet<string> = new Set([
  "rect",
  "ellipse",
  "diamond",
  "line",
  "arrow",
  "highlight",
  "curvearrow",
  "labeled",
  "angle",
]);

export type RawBlock =
  /** A line (or a few, with \n) of the notes column. */
  | { kind: "text"; op: DrawOp }
  /** One diagram primitive, placed as a unit. */
  | { kind: "figure"; ops: DrawOp[] }
  /** The beat's free-form sketch, placed as a unit; its coordinates are relative. */
  | { kind: "sketch"; ops: DrawOp[] }
  /** Client-authored furniture drawn at its own page-local coordinates. */
  | { kind: "fixed"; ops: DrawOp[] }
  /** Attached to a figure by name, or pointing at an element by id: resolved by the player. */
  | { kind: "anchored"; op: DrawOp }
  /** A transient pointing gesture with coordinates: lives only inside a sketch frame. */
  | { kind: "gesture"; op: DrawOp }
  /** erase / clear. */
  | { kind: "control"; op: DrawOp };

export function isAnchoredOp(op: DrawOp): boolean {
  return Boolean(op.at || op.from || op.to);
}

export function isGesture(op: DrawOp): boolean {
  if (op.temp === true) return true;
  // A bare arrow is a pointing gesture unless the model insists it is notes.
  return op.op === "arrow" && op.temp !== false;
}

const hasXY = (op: DrawOp) => typeof op.x === "number" && typeof op.y === "number";

/**
 * Sort a beat's ops into blocks, in order. The one judgement call is a `text`
 * op that carries x/y: beside sketch shapes it is a label inside that sketch
 * (the coordinates relate it to the shapes); on its own it is simply a line of
 * notes, and its coordinates are ignored. Gestures never count as shapes.
 */
export function groupBlocks(ops: DrawOp[]): RawBlock[] {
  const out: RawBlock[] = [];
  const fixed = ops.filter((o) => o.layout === "fixed");
  const rest = ops.filter((o) => o.layout !== "fixed");
  if (fixed.length) out.push({ kind: "fixed", ops: fixed });

  // The shapes that give a sketch its frame of reference. A highlight is not
  // one: it overlays something, it does not establish where anything is.
  const shapes = rest.filter((o) => SKETCH_OPS.has(o.op) && o.op !== "highlight" && !isAnchoredOp(o) && !isGesture(o) && hasXY(o));
  const sketchOps: DrawOp[] = [];
  let sketchAt = -1;
  for (const op of rest) {
    if (op.op === "erase" || op.op === "clear") {
      out.push({ kind: "control", op });
      continue;
    }
    if (isAnchoredOp(op)) {
      out.push({ kind: "anchored", op });
      continue;
    }
    if (isGesture(op)) {
      // A gesture with coordinates rides the sketch those coordinates belong
      // to — this beat's, or the turn's earlier one via the sketch frame; the
      // engine drops it if there is no such sketch. One without coordinates
      // points at nothing the board can find.
      if (hasXY(op)) {
        if (sketchAt < 0) sketchAt = out.length;
        sketchOps.push(op);
      } else {
        out.push({ kind: "gesture", op });
      }
      continue;
    }
    if (FIGURE_OPS.has(op.op)) {
      out.push({ kind: "figure", ops: [op] });
      continue;
    }
    if (SKETCH_OPS.has(op.op) && hasXY(op)) {
      if (sketchAt < 0) sketchAt = out.length;
      sketchOps.push(op);
      continue;
    }
    if (op.op === "text") {
      if (shapes.length && hasXY(op)) {
        if (sketchAt < 0) sketchAt = out.length;
        sketchOps.push(op);
      } else if (op.text) {
        out.push({ kind: "text", op });
      }
      continue;
    }
    // A sketch op with no coordinates at all (a lone highlight with nothing to
    // point at): nothing to place.
  }
  if (sketchOps.length) {
    // The sketch sits where its first op appeared in reading order.
    out.splice(sketchAt < 0 ? out.length : sketchAt, 0, { kind: "sketch", ops: sketchOps });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Measured blocks: what the engine is given once the player has sized things.
// ---------------------------------------------------------------------------

export type TextBlock = {
  kind: "text";
  index: number;
  op: DrawOp;
  fontPx: number;
  /** The model's lines (split on \n), before wrapping. */
  lines: string[];
  /** Laid out as superscript/subscript runs: taller leading. */
  math: boolean;
};

export type BoxBlock = {
  kind: "figure" | "sketch" | "fixed";
  index: number;
  ops: DrawOp[];
  /** Measured extent in the ops' own (model) coordinates. */
  bbox: Rect;
  scalable: boolean;
  place: "right" | "below" | null;
  /** Nothing but pointing gestures: drawn only over a sketch frame, never placed on its own. */
  gestureOnly?: boolean;
};

export type Block = TextBlock | BoxBlock;

export type Float = { rect: Rect; ids: string[] };

/** Where the next thing goes on one page. */
export type PageLayout = { cursorY: number; floats: Float[] };

export function freshPageLayout(cursorY = CONTENT_TOP): PageLayout {
  return { cursorY, floats: [] };
}

/**
 * The turn's sketch frame: where its first sketch landed relative to the
 * model's coordinates, so a later beat that draws over that sketch (a
 * highlight on the pizza, a label on the cell) lands over it on the board too.
 */
export type SketchFrame = { model: Rect; dx: number; dy: number };

export type Placement =
  | { kind: "text"; index: number; page: number; x: number; y: number; lines: string[]; fontPx: number; math: boolean }
  | { kind: "box"; index: number; page: number; x: number; y: number; scale: number };

export type LayoutResult = {
  placements: Placement[];
  /** Layout state of the page the beat started on, then of each page it added. */
  pages: PageLayout[];
  frame: SketchFrame | null;
};

export type Measure = (text: string, fontPx: number) => number;

export function lineHeightPx(fontPx: number): number {
  return Math.round(fontPx * 1.25);
}

export function textBlockHeight(n: number, fontPx: number, math: boolean): number {
  return n * lineHeightPx(fontPx) + (math ? (n - 1) * MATH_LINE_GAP : 0);
}

export function blockFontPx(op: DrawOp): number {
  return op.px ?? FONT_PX[op.size ?? "md"];
}

export function textBlockOf(op: DrawOp, index: number): TextBlock {
  const text = String(op.text ?? "");
  return { kind: "text", index, op, fontPx: blockFontPx(op), lines: text.split("\n"), math: hasMathNotation(text) };
}

/**
 * Greedy word wrap to `maxW`. A single word wider than the column is kept whole
 * on its own line rather than cut: a cut formula misleads, an overhang does not.
 */
export function wrapLine(line: string, fontPx: number, maxW: number, measure: Measure): string[] {
  if (measure(line, fontPx) <= maxW) return [line];
  const words = line.split(/(\s+)/).filter((w) => w.length);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur.trim() && !w.trim()) continue; // never start a line with a space
    const next = cur + w;
    if (cur.trim() && measure(next.trimEnd(), fontPx) > maxW && w.trim()) {
      out.push(cur.trimEnd());
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out.length ? out : [line];
}

const inflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });
const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const unionRect = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

class Restart extends Error {}

/**
 * Lay one beat out, starting from the state of the page it lands on.
 *
 * Two passes over the blocks: floats first (every figure or sketch narrow
 * enough to sit beside the notes is pinned at the beat's top, so the text that
 * follows wraps around it — placing in reading order would set the text full
 * width and then drop the figure onto it), then everything else in order.
 *
 * A figure that does not fit while the beat has placed little or nothing on
 * this page restarts the whole beat on a fresh page, which is what keeps a
 * caption with its figure and a heading with its first block. On a fresh page a
 * scalable figure that is still too tall is shrunk to fit.
 */
export function layoutBeat(
  blocks: Block[],
  start: PageLayout,
  frame0: SketchFrame | null,
  measure: Measure,
  opts: { startsFresh?: boolean } = {},
): LayoutResult {
  const pages: PageLayout[] = [{ cursorY: start.cursorY, floats: start.floats.map((f) => ({ ...f })) }];
  let placements: Placement[] = [];
  let frame = frame0;

  // State of the page currently being filled.
  let pageNo = 0;
  let st = pages[0];
  // How far this beat has committed on the current page: the restart rule.
  let linesOnPage = 0;
  let boxesOnPage = 0;
  let pageIsFresh = Boolean(opts.startsFresh);

  const newPage = () => {
    pageNo++;
    st = freshPageLayout();
    pages.push(st);
    linesOnPage = 0;
    boxesOnPage = 0;
    pageIsFresh = true;
    frame = null; // a sketch frame does not cross pages
  };

  const floatBottom = (): number => st.floats.reduce((m, f) => Math.max(m, f.rect.y + f.rect.h), -Infinity);
  const roomBelow = (y: number) => CONTENT_BOTTOM - y;

  /** Shrink factor so a box of height `h` fits `room`, or 1. */
  const fitScale = (b: BoxBlock, w: number, h: number, room: number, width: number): number => {
    if (h <= room && w <= width) return 1;
    if (!b.scalable) return 1;
    return Math.max(MIN_SCALE, Math.min(room / h, width / w, 1));
  };

  /**
   * Beside a float the notes column is often empty: a figure that fits in that
   * strip at the cursor goes there — the layout a teacher would choose over
   * stacking it under the float or starting a new page. Null when it does not fit.
   */
  const tryLeftStrip = (b: BoxBlock) => {
    const strip = availableWidth(st.cursorY, b.bbox.h);
    if (strip.w >= COL_W) return null; // no float beside the cursor
    const s = fitScale(b, b.bbox.w, b.bbox.h, roomBelow(st.cursorY), strip.w);
    const w = b.bbox.w * s;
    const h = b.bbox.h * s;
    if (s < KEEP_SCALE || w > strip.w || st.cursorY + h > CONTENT_BOTTOM) return null;
    const placed = { x: CONTENT_LEFT, y: st.cursorY, w, h, s };
    placements.push({ kind: "box", index: b.index, page: pageNo, x: placed.x, y: placed.y, scale: s });
    st.cursorY = placed.y + h + CLEARANCE;
    boxesOnPage++;
    return placed;
  };

  const placeFloat = (b: BoxBlock, beatTop: number) => {
    let s = fitScale(b, b.bbox.w, b.bbox.h, Infinity, FLOAT_MAX_W);
    let w = b.bbox.w * s;
    let h = b.bbox.h * s;
    const prev = st.floats.length ? floatBottom() + CLEARANCE : -Infinity;
    const y = Math.max(beatTop, prev);
    if (y + h > CONTENT_BOTTOM) {
      const fit = fitScale(b, b.bbox.w, b.bbox.h, roomBelow(y), FLOAT_MAX_W);
      const fits = fit * b.bbox.h <= roomBelow(y) + 0.5;
      const fresh = pageIsFresh && !linesOnPage && !boxesOnPage;
      if (!fresh && !(fits && fit >= KEEP_SCALE)) {
        const left = tryLeftStrip(b);
        if (left) return left;
        throw new Restart();
      }
      s = fit;
      w = b.bbox.w * s;
      h = b.bbox.h * s;
    }
    const x = CONTENT_RIGHT - w;
    st.floats.push({ rect: { x, y, w, h }, ids: b.ops.map((o) => o.id ?? "").filter(Boolean) });
    placements.push({ kind: "box", index: b.index, page: pageNo, x, y, scale: s });
    boxesOnPage++;
    return { x, y, w, h, s };
  };

  /** Two small figures as ONE float: side by side at the right, text wraps beside both. */
  const placeFloatPair = (a: BoxBlock, b: BoxBlock, beatTop: number) => {
    const totalW = a.bbox.w + FLOAT_GAP + b.bbox.w;
    const h = Math.max(a.bbox.h, b.bbox.h);
    const prev = st.floats.length ? floatBottom() + CLEARANCE : -Infinity;
    const y = Math.max(beatTop, prev);
    // A pair a little wider than the float column shrinks into it.
    let s = Math.min(1, FLOAT_MAX_W / totalW);
    if (y + h * s > CONTENT_BOTTOM) {
      const fit = Math.min(fitScale(a, a.bbox.w, a.bbox.h, roomBelow(y), FLOAT_MAX_W), fitScale(b, b.bbox.w, b.bbox.h, roomBelow(y), FLOAT_MAX_W));
      const fresh = pageIsFresh && !linesOnPage && !boxesOnPage;
      if (!fresh && !(fit >= KEEP_SCALE && fit * h <= roomBelow(y) + 0.5)) return null;
      s = Math.min(s, fit);
    }
    const x0 = CONTENT_RIGHT - totalW * s;
    placements.push({ kind: "box", index: a.index, page: pageNo, x: x0, y, scale: s });
    placements.push({ kind: "box", index: b.index, page: pageNo, x: x0 + (a.bbox.w + FLOAT_GAP) * s, y, scale: s });
    st.floats.push({ rect: { x: x0, y, w: totalW * s, h: h * s }, ids: [...a.ops, ...b.ops].map((o) => o.id ?? "").filter(Boolean) });
    boxesOnPage += 2;
    return { x: x0, y, w: totalW * s, h: h * s, s };
  };

  const placeInline = (b: BoxBlock, w: number, h: number, scaleIn: number, x: number) => {
    if (tryLeftStrip(b)) return;
    // Full width: below every float that reaches past the cursor.
    let y = st.cursorY;
    for (const f of st.floats) if (f.rect.y + f.rect.h > y - CLEARANCE) y = Math.max(y, f.rect.y + f.rect.h + CLEARANCE);
    let s = scaleIn;
    if (y + h > CONTENT_BOTTOM) {
      const fit = fitScale(b, b.bbox.w, b.bbox.h, roomBelow(y), COL_W);
      const keep = fit >= KEEP_SCALE && fit * b.bbox.h <= roomBelow(y) + 0.5;
      if (!keep) {
        if (linesOnPage <= KEEP_WITH_NEXT_LINES && boxesOnPage === 0 && !pageIsFresh) throw new Restart();
        if (linesOnPage || boxesOnPage || st.floats.length) {
          newPage();
          y = st.cursorY;
        }
      }
      s = fitScale(b, b.bbox.w, b.bbox.h, roomBelow(y), COL_W);
      w = b.bbox.w * s;
      h = b.bbox.h * s;
    }
    // A figure on its own line is centred in the column, as in a printed book.
    if (b.kind === "figure") x = Math.max(x, CONTENT_LEFT + (COL_W - w) / 2);
    placements.push({ kind: "box", index: b.index, page: pageNo, x, y, scale: s });
    st.cursorY = y + h + CLEARANCE;
    boxesOnPage++;
  };

  const availableWidth = (y: number, h: number): { w: number; below: number } => {
    let x1 = CONTENT_RIGHT;
    let below = -Infinity;
    for (const f of st.floats) {
      if (f.rect.y < y + h && f.rect.y + f.rect.h > y) {
        x1 = Math.min(x1, f.rect.x);
        below = Math.max(below, f.rect.y + f.rect.h);
      }
    }
    return { w: x1 === CONTENT_RIGHT ? COL_W : x1 - FLOAT_GAP - CONTENT_LEFT, below };
  };

  const placeText = (b: TextBlock) => {
    let remaining = b.lines;
    while (remaining.length) {
      // Wrap for the width available at the cursor; if a float leaves too thin
      // a strip, drop below it and use the full column instead.
      let y = st.cursorY;
      let probe = availableWidth(y, textBlockHeight(remaining.length, b.fontPx, b.math));
      if (probe.w < MIN_TEXT_W) {
        y = probe.below + CLEARANCE;
        probe = availableWidth(y, textBlockHeight(remaining.length, b.fontPx, b.math));
      }
      const wrapped = remaining.flatMap((l) => wrapLine(l, b.fontPx, probe.w, measure));
      const h = textBlockHeight(wrapped.length, b.fontPx, b.math);
      if (y + h <= CONTENT_BOTTOM) {
        placements.push({ kind: "text", index: b.index, page: pageNo, x: CONTENT_LEFT, y, lines: wrapped, fontPx: b.fontPx, math: b.math });
        st.cursorY = y + h + TEXT_GAP;
        linesOnPage += wrapped.length;
        return;
      }
      // A short caption right after this beat's figure: the figure goes with it
      // to the next page rather than being left captionless at the bottom.
      if (!pageIsFresh && boxesOnPage === 1 && linesOnPage <= KEEP_WITH_NEXT_LINES && wrapped.length <= 2) throw new Restart();
      // Does not fit: split at a line boundary if both halves are worth a page.
      const lineH = lineHeightPx(b.fontPx) + (b.math ? MATH_LINE_GAP : 0);
      const fits = Math.floor((CONTENT_BOTTOM - y + (b.math ? MATH_LINE_GAP : 0)) / lineH);
      if (fits >= MIN_SPLIT_LINES && wrapped.length - fits >= MIN_SPLIT_LINES) {
        const head = wrapped.slice(0, fits);
        placements.push({ kind: "text", index: b.index, page: pageNo, x: CONTENT_LEFT, y, lines: head, fontPx: b.fontPx, math: b.math });
        linesOnPage += head.length;
        // The tail is re-wrapped for the fresh page's full width.
        remaining = [wrapped.slice(fits).join(" ")];
        newPage();
        continue;
      }
      if (pageIsFresh && !linesOnPage && !boxesOnPage && !st.floats.length) {
        // Taller than a whole page on its own: write it and let it run long.
        placements.push({ kind: "text", index: b.index, page: pageNo, x: CONTENT_LEFT, y, lines: wrapped, fontPx: b.fontPx, math: b.math });
        st.cursorY = y + h + TEXT_GAP;
        linesOnPage += wrapped.length;
        return;
      }
      newPage();
    }
  };

  const run = () => {
    placements = [];
    const beatTop = st.cursorY;
    const floated = new Set<number>();
    const rows = new Map<number, BoxBlock>(); // first block index -> partner

    // Pass 1: which boxes float, and which pairs form a row.
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.kind === "text" || b.kind === "fixed") continue;
      if (frame && b.kind === "sketch" && intersects(inflate(frame.model, FRAME_REACH), b.bbox)) continue; // rides the frame
      if (b.gestureOnly) continue;
      const next = blocks[i + 1];
      if (b.kind === "figure" && next?.kind === "figure" && !b.place && !next.place) {
        // Two small figures side by side FLOAT together, so the notes that
        // explain them flow beside the pair instead of under it.
        const pairW = b.bbox.w + FLOAT_GAP + next.bbox.w;
        if (pairW <= FLOAT_MAX_W || (b.scalable && next.scalable && FLOAT_MAX_W / pairW >= FLOAT_SHRINK)) {
          const pair = placeFloatPair(b, next, beatTop);
          if (pair) {
            floated.add(i);
            floated.add(i + 1);
            i++;
            continue;
          }
        }
        if (b.bbox.w + FLOAT_GAP + next.bbox.w <= COL_W) {
          rows.set(i, next);
          i++;
          continue;
        }
      }
      if (b.place === "below") continue;
      // A figure wider than the float column still floats when a modest shrink
      // brings it in: a smaller diagram beside its notes beats a full-width
      // one that pushes the notes to the next page.
      if (b.bbox.w > FLOAT_MAX_W && !(b.scalable && FLOAT_MAX_W / b.bbox.w >= FLOAT_SHRINK)) continue;
      const placed = placeFloat(b, beatTop);
      floated.add(i);
      // A frame only makes sense at scale 1: a later op's coordinates are the model's.
      if (b.kind === "sketch" && placed.s === 1) frame = { model: b.bbox, dx: placed.x - b.bbox.x, dy: placed.y - b.bbox.y };
    }

    // Pass 2: everything else, in reading order.
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (floated.has(i)) continue;
      if (b.kind === "text") {
        placeText(b);
        continue;
      }
      if (b.kind === "fixed") {
        placements.push({ kind: "box", index: b.index, page: pageNo, x: b.bbox.x, y: b.bbox.y, scale: 1 });
        st.cursorY = Math.max(st.cursorY, b.bbox.y + b.bbox.h + TEXT_GAP);
        boxesOnPage++;
        continue;
      }
      const partner = rows.get(i);
      if (partner) {
        // Two figures side by side: one row as tall as the taller of them.
        const h = Math.max(b.bbox.h, partner.bbox.h);
        let y = st.cursorY;
        for (const f of st.floats) if (f.rect.y + f.rect.h > y - CLEARANCE) y = Math.max(y, f.rect.y + f.rect.h + CLEARANCE);
        const rowScale = (room: number) =>
          Math.min(fitScale(b, b.bbox.w, b.bbox.h, room, COL_W), fitScale(partner, partner.bbox.w, partner.bbox.h, room, COL_W));
        if (y + h > CONTENT_BOTTOM) {
          const fit = rowScale(roomBelow(y));
          const keep = fit >= KEEP_SCALE && fit * h <= roomBelow(y) + 0.5;
          if (!keep) {
            if (linesOnPage <= KEEP_WITH_NEXT_LINES && boxesOnPage === 0 && !pageIsFresh) throw new Restart();
            if (linesOnPage || boxesOnPage || st.floats.length) {
              newPage();
              y = st.cursorY;
            }
          }
        }
        const s = rowScale(roomBelow(y));
        const w1 = b.bbox.w * s;
        const rowW = w1 + FLOAT_GAP + partner.bbox.w * s;
        const x0 = CONTENT_LEFT + Math.max(0, (COL_W - rowW) / 2);
        placements.push({ kind: "box", index: b.index, page: pageNo, x: x0, y, scale: s });
        placements.push({ kind: "box", index: partner.index, page: pageNo, x: x0 + w1 + FLOAT_GAP, y, scale: s });
        st.cursorY = y + Math.max(b.bbox.h, partner.bbox.h) * s + CLEARANCE;
        boxesOnPage += 2;
        i++;
        continue;
      }
      if (frame && b.kind === "sketch" && intersects(inflate(frame.model, FRAME_REACH), b.bbox)) {
        // Over the turn's earlier sketch: same frame, no cursor movement.
        placements.push({ kind: "box", index: b.index, page: pageNo, x: frame.dx + b.bbox.x, y: frame.dy + b.bbox.y, scale: 1 });
        if (!b.gestureOnly) frame = { ...frame, model: unionRect(frame.model, b.bbox) };
        continue;
      }
      if (b.gestureOnly) continue; // a gesture with no sketch under it points at nothing
      const s = fitScale(b, b.bbox.w, b.bbox.h, Infinity, COL_W);
      placeInline(b, b.bbox.w * s, b.bbox.h * s, s, CONTENT_LEFT);
      if (b.kind === "sketch") {
        const last = placements[placements.length - 1] as Extract<Placement, { kind: "box" }>;
        frame = last.scale === 1 ? { model: b.bbox, dx: last.x - b.bbox.x, dy: last.y - b.bbox.y } : null;
      }
    }
  };

  try {
    run();
  } catch (e) {
    if (!(e instanceof Restart)) throw e;
    // The beat as a whole moves to a fresh page.
    pages.length = 1;
    pages[0] = { cursorY: start.cursorY, floats: start.floats.map((f) => ({ ...f })) };
    pageNo = 0;
    st = pages[0];
    frame = frame0;
    newPage();
    run();
  }
  return { placements, pages, frame };
}
