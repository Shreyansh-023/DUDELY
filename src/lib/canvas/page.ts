/** One source of truth for page geometry. Imported by the player, the scene
 *  summary AND the prompt builder, so the budget the model is told and the page
 *  the renderer draws on can never drift. Pure constants and pure functions —
 *  no "use client", no @excalidraw import: prompt.ts imports this on the server. */

export const PAGE_W = 1280;
export const PAGE_H = 720;
/** Empty scene space between neighbouring pages, so a page break reads as a break. */
export const PAGE_GUTTER = 120;
/** Scene-space distance between two page origins down a column. */
export const PAGE_PITCH = PAGE_H + PAGE_GUTTER; // 840
/** Scene-space distance between two page origins across a row. */
export const PAGE_PITCH_X = PAGE_W + PAGE_GUTTER; // 1400

/** The writable box inside a page, in PAGE-LOCAL coordinates. */
export const CONTENT_LEFT = 80;
export const CONTENT_TOP = 80;
export const CONTENT_RIGHT = 1200;
export const CONTENT_BOTTOM = 660;

/** Vertical pitch of one `md` text line (prompt.ts's layout rule). */
export const MD_PITCH = 50;
/** Clearance left below existing content when suggesting an origin. */
export const CLEARANCE = 40;
/**
 * Vertical break between two lesson STEPS that share a page. Wider than
 * CLEARANCE (which separates beats inside one step) so that two subtopics on
 * one page still read as two subtopics.
 */
export const STEP_GAP = 72;
/** A teaching turn needs at least this much room to continue an existing page. */
export const MIN_TURN_ROOM = 200;
/**
 * Room a NEW LESSON STEP needs before it will share a page with the step above
 * it. A step is a whole subtopic — a title plus several lines, sometimes a
 * diagram — so it wants more than a single turn does (MIN_TURN_ROOM), but far
 * less than a whole page: demanding a whole page is what left steps sitting
 * alone on a mostly-empty sheet. Roughly a title plus four md lines.
 */
export const MIN_STEP_ROOM = 300;
/** Below this much room the page is reported FULL. */
export const PAGE_FULL_ROOM = MD_PITCH + CLEARANCE; // 90
/** How many md text lines a blank page holds. */
export const MD_LINES_PER_PAGE = Math.floor((CONTENT_BOTTOM - CONTENT_TOP) / MD_PITCH); // 11

/** Camera: page covers this fraction of the viewport; zoom is clamped by hand
 *  because updateScene does not clamp or validate. */
export const FIT_PAD = 0.94;
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 30;
export const TWEEN_MS = 420;
/** Safety slack on the pre-collision beat fit test. */
export const FIT_MARGIN = 24;

export type PageKind = "teach" | "doubt";
export type Rect = { x: number; y: number; w: number; h: number };
/** Where a page sits on the infinite sheet. See `cellRect`. */
export type Cell = { row: number; col: number };
export type PageFrame = Rect & Cell & { index: number; count: number; kind: PageKind };

/**
 * Scene rect of the page in grid cell (row, col).
 *
 * The book is a GRID, not a single column: the lesson runs straight down
 * column 0, one row per step, and a doubt raised during a step takes the cell
 * immediately to its RIGHT (col 1, the next doubt in that row col 2, ...). So
 * the teaching column is never broken by a side-note, and returning from a
 * doubt is a step back to the left rather than a scroll back through the book.
 *
 * Page-local coordinates are always relative to this rect's origin: everything
 * that reports a position to the model subtracts BOTH frame.x and frame.y.
 */
export function cellRect(row: number, col: number): Rect {
  return { x: col * PAGE_PITCH_X, y: row * PAGE_PITCH, w: PAGE_W, h: PAGE_H };
}

/** Scene rect of the `i`-th page of a doubt-free lesson: straight down column 0.
 *  Only for callers with no cell to hand (defaults, blank-page previews). */
export function pageRect(i: number): Rect {
  return cellRect(i, 0);
}

/** Which cell a raw scene point falls in. Only for elements with no page tag
 *  (student strokes, pre-upgrade content). */
export function cellAtScene(x: number, y: number): Cell {
  return { row: Math.max(0, Math.floor(y / PAGE_PITCH)), col: Math.max(0, Math.floor(x / PAGE_PITCH_X)) };
}

/** Pure viewport maths. Returns null for any degenerate input, never NaN. */
export function fitPage(
  rect: Rect,
  viewportW: number,
  viewportH: number,
  pad = FIT_PAD,
): { scrollX: number; scrollY: number; zoom: number } | null {
  if (!(viewportW > 0) || !(viewportH > 0) || !(rect.w > 0) || !(rect.h > 0)) return null;
  const raw = Math.min(viewportW / rect.w, viewportH / rect.h) * pad;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw));
  return {
    zoom,
    scrollX: viewportW / (2 * zoom) - (rect.x + rect.w / 2),
    scrollY: viewportH / (2 * zoom) - (rect.y + rect.h / 2),
  };
}

// ---------------------------------------------------------------------------
// The ONE copy of the page prose the model reads. summary.ts and prompt.ts
// both call these; nothing else formats page text.
// ---------------------------------------------------------------------------

export function pageHeaderLine(f: PageFrame): string {
  const kind = f.kind === "doubt" ? " (doubt page)" : "";
  return `Page ${f.index + 1} of ${f.count}${kind}. This page is ${PAGE_W} x ${PAGE_H}. Draw inside x ${CONTENT_LEFT}..${CONTENT_RIGHT} and y ${CONTENT_TOP}..${CONTENT_BOTTOM}.`;
}

export function roomLine(remaining: number): string {
  const r = Math.max(0, Math.round(remaining));
  return `Room left on this page: ${r} px (about ${Math.floor(r / MD_PITCH)} md text lines).`;
}

/** Appended when room is low but the page is still usable. */
export function lowRoomLine(remaining: number): string {
  return `Only ${Math.floor(Math.max(0, remaining) / MD_PITCH)} md text lines fit here — keep this turn to one or two short beats and stop cleanly; the next turn starts on a fresh blank page at (${CONTENT_LEFT}, ${CONTENT_TOP}).`;
}

export const PAGE_FULL_LINES: readonly string[] = [
  "This page is FULL — do not place anything else on it.",
  `You will be given a fresh page: start again at the top-left, (${CONTENT_LEFT}, ${CONTENT_TOP}).`,
];

/** Below this much room, append lowRoomLine to the suggestion. */
export const LOW_ROOM = 240;

export function blankPageCanvas(index = 0, count = 1, kind: PageKind = "teach"): string {
  return [
    pageHeaderLine({ ...pageRect(index), row: index, col: 0, index, count, kind }),
    "(this page is blank — start at the top-left)",
    `Suggested top-left for new content: (${CONTENT_LEFT}, ${CONTENT_TOP})`,
    roomLine(CONTENT_BOTTOM - CONTENT_TOP),
  ].join("\n");
}
