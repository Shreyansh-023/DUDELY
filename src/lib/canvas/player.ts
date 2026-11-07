"use client";

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getCommonBounds,
  newElementWith,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { DrawOp } from "../schema";
import { clamp, sleep } from "../utils";
import {
  anchoredAngle,
  anchoredHighlight,
  anchoredLabel,
  elementHighlight,
  pointerArrow,
  resolvePoint,
  retargetSide,
  segmentLabel,
  splitAnchorRef,
  transformAnchors,
  type Figure,
} from "./anchors";
import {
  freshPageLayout,
  groupBlocks,
  isGesture,
  layoutBeat,
  textBlockOf,
  type Block,
  type BoxBlock,
  type PageLayout,
  type Placement,
  type RawBlock,
  type SketchFrame,
  type TextBlock,
} from "./layout";
import { fontsReady, measureText } from "./measure";
import { flattenMath, hasMathNotation, normalizeScripts, symbolsForWords } from "./mathtext";
import { isPermanentNote, opToSkeleton, type TutorMeta } from "./ops";
import {
  CLEARANCE,
  CONTENT_LEFT,
  CONTENT_RIGHT,
  CONTENT_TOP,
  HEADING_GAP,
  MIN_TURN_ROOM,
  CONTENT_BOTTOM,
  PAGE_W,
  STEP_GAP,
  TWEEN_MS,
  cellAtScene,
  cellRect,
  fitPage,
  pageRect,
  type Cell,
  type PageFrame,
  type PageKind,
  type Rect,
} from "./page";
import { PRIMITIVES, expandPrimitive, type Expanded } from "./primitives";
import { expandMathText } from "./primitives/mathline";
import { SCALABLE_OPS, readableSize, scaleOp, type Pt } from "./primitives/util";

/** One page of the board, plus the bookkeeping the UI and the layout need.
 *  `Cell` is where it sits on the sheet; `index` is only the order it was
 *  allocated in. */
type Page = Rect &
  Cell & {
    /** Allocation order. This is what `customData.page` tags and what the
     *  "Page N of M" header counts; the geometry is (row, col). */
    index: number;
    kind: PageKind;
    /** At least one permanent element has been committed here. */
    used: boolean;
    /** Lowest occupied PAGE-LOCAL y; CONTENT_TOP while empty. */
    bottom: number;
    /** Bumps on every commit to this page — the thumbnail cache key. */
    rev: number;
    /** turn -> every element id it created here, so dropTurn can wipe a turn. */
    turnIds: Map<number, Set<string>>;
    /** Where the next flowed content goes: the cursor and the figures text may wrap beside. */
    layout: PageLayout;
    /** Something other than furniture (heading, question) has been flowed here. */
    bodyPlaced: boolean;
    /** The figure a bare `at: "A"` refers to on this page. */
    lastFigure: string | null;
    /** Student strokes already folded into the layout state. */
    seenStudent: Set<string>;
    /**
     * The page this one is shown together with, as a two-page spread. A step
     * that runs past its page continues on the page to the RIGHT of it, and
     * the camera frames both — the figure stays in view while the explanation
     * under it carries on, the way a teacher keeps the diagram on the board.
     */
    spreadWith: number | null;
  };

export type PageInfo = Cell & { index: number; kind: PageKind; used: boolean; rev: number };
/** `pages` is in ALLOCATION order; reading order is by row, then col — which is
 *  what puts a step's doubts straight after the step. See BoardPager. */
export type PageSnapshot = {
  pages: readonly PageInfo[];
  /** Page Indica is writing on; -1 before the first permanent element. */
  activeIndex: number;
  /** Page the camera is framing; -1 before the first frame. */
  viewIndex: number;
  /** False while the student is reading a page other than activeIndex. */
  follow: boolean;
};

/**
 * Plays draw ops onto a live Excalidraw scene with a "hand-drawn" feel:
 * text is typed out character by character, arrows grow from start to end,
 * shapes fade in. Everything is appended with CaptureUpdateAction.NEVER so
 * the student's undo stack is untouched.
 *
 * WHERE things go is decided by the flow layout engine (layout.ts), never by
 * the model's coordinates: each beat is split into blocks, the engine places
 * them below and beside what the page already holds, and this class only
 * draws at the positions it is handed. Ops that annotate a figure name the
 * part they belong to and are resolved against the figure's committed
 * geometry (anchors.ts). There is no collision pass, because nothing is ever
 * placed where something already is.
 */
export class BoardPlayer {
  /** LLM-chosen id -> actual element id in the scene. */
  private idMap = new Map<string, string>();
  /** Every scene id ever handed out, so one is never issued twice. See resolveId. */
  private minted = new Set<string>();
  /** The turn currently being drawn, so "jump to Guru" knows where to look. */
  private currentTurn = 0;
  /** The last turn we auto-recentered on, so we jump once at the start of each turn. */
  private recenteredTurn = 0;
  /** Pending fade-out timers for transient annotations, cancelled on clear. */
  private ephemeralTimers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * Paging: the board is a column of fixed PAGE_W x PAGE_H pages rather than one
   * endless surface. Everything is laid out in PAGE-LOCAL coordinates and the
   * player adds the page origin at draw time, so a page is simply a rect in
   * scene space that the camera frames exactly.
   *
   * Pages are allocated LAZILY — only when a beat actually commits a permanent
   * element — so the planner turn, the familiarity question and a doubt that
   * comes back as prose with no drawing can never mint a blank page the student
   * then has to scroll past.
   */
  private pages: Page[] = [];
  /** Where the NEXT content lands. Valid before the page exists (== pages.length). */
  private plannedIndex = 0;
  /** The grid cell that planned page occupies — the geometry `plannedIndex`
   *  alone can no longer give, now that doubts sit beside the lesson. */
  private plannedCell: Cell = { row: 0, col: 0 };
  private plannedKind: PageKind = "teach";
  private activeIndex = -1;
  /** The teaching page to continue, and to return to after a doubt. */
  private teachIndex = -1;
  /** teachIndex captured at the FIRST doubt of a run of them. */
  private returnIndex = -1;
  private framedIndex = -1;
  private doubtMode = false;
  /** False while the student is reading a page other than the one being written. */
  private follow = true;
  private tween: number | null = null;
  /** The last viewport we wrote, so a student pan can be told from our own tween. */
  private lastWrote: { scrollX: number; scrollY: number; zoom: number } | null = null;
  private listeners = new Set<() => void>();
  private snapshot: PageSnapshot = { pages: [], activeIndex: -1, viewIndex: -1, follow: true };
  /** Primitives are expanded once per op: measuring and drawing share this. */
  private expandCache = new WeakMap<object, Expanded>();
  /** Every figure placed so far, by the model's id, with its committed geometry. */
  private figures = new Map<string, Figure>();
  /**
   * Where this turn's free-form sketch landed relative to the model's own
   * coordinates, so a later beat that draws over it lands over it on the board.
   */
  private sketchFrame: { turn: number; page: number; frame: SketchFrame } | null = null;

  constructor(private api: ExcalidrawImperativeAPI) {}

  // --- write-cursor intent -------------------------------------------------
  // These say where the NEXT content goes. They allocate nothing and touch no
  // scene state, so Tutor can call them synchronously before the fetch and then
  // summarise the very page the model is about to draw on.

  /**
   * Begin a teaching turn. Continues the current teaching page while it still
   * has room, otherwise starts a fresh page on a NEW ROW at the head of the
   * teaching column — which is what keeps the lesson running straight down one
   * column and never into a doubt's page beside it.
   * `stayOnPage` keeps the reply beside work the student just drew.
   *
   * `newStep` begins a new lesson step, and ALWAYS on a fresh page: one
   * subtopic never starts half-way down the page another one ends on. Each step
   * is written under its own numbered heading (see `drawStepHeading` below),
   * and a heading that appears mid-page reads as a divider rather than a title —
   * so the page break is what makes the heading mean anything.
   *
   * A step is free to take MORE than one page: the layout engine continues a
   * beat that does not fit on a fresh page. Those spill pages carry no heading
   * of their own, so a long subtopic reads as one continuous stretch under the
   * one heading it started with.
   *
   * `freshPage` opts out of sharing entirely: the turn gets a clean sheet even
   * if the current page has room. A solved question needs this: its question
   * block is furniture drawn at the top of the page.
   */
  beginTeachTurn(opts?: { stayOnPage?: boolean; newStep?: boolean; freshPage?: boolean }) {
    this.doubtMode = false;
    this.plannedKind = "teach";
    this.sketchFrame = null;
    this.ephemeralLingerMs = BoardPlayer.EPHEMERAL_LINGER_MS;
    if (opts?.freshPage) {
      this.planAt(this.freshTeachSlot());
      this.emit();
      return;
    }
    if (opts?.stayOnPage && this.activeIndex >= 0) {
      this.planAt(this.pages[this.activeIndex]);
      this.emit();
      return;
    }
    // A new step never shares: it opens its own page under its own heading.
    const cur = this.teachIndex >= 0 ? this.pages[this.teachIndex] : undefined;
    const share =
      !opts?.newStep && Boolean(cur && cur.kind === "teach" && CONTENT_BOTTOM - cur.bottom >= MIN_TURN_ROOM);
    if (share && cur && cur.used) {
      // Two subtopics on one page read as two subtopics: a wider gap than the
      // one between beats. A figure the previous turn floated is still a float.
      cur.layout.cursorY = Math.max(cur.layout.cursorY, cur.bottom + STEP_GAP);
    }
    this.planAt(share && cur ? cur : this.freshTeachSlot());
    this.emit();
  }

  /**
   * Begin a doubt answer on its own new page, placed in the same row as the
   * lesson page it interrupts and one column to its right — a neighbour, so the
   * quick side-note never breaks the teaching column and the way back is one
   * step left onto the page the lesson paused on.
   *
   * Transient pointing arrows linger longer here: a confused student re-reads a
   * pointer more slowly than a teaching aside.
   */
  beginDoubtTurn() {
    this.sketchFrame = null;
    if (!this.doubtMode) this.returnIndex = this.teachIndex; // only the FIRST doubt sets the way back
    this.doubtMode = true;
    this.plannedKind = "doubt";
    this.planAt(this.freshDoubtSlot());
    this.ephemeralLingerMs = BoardPlayer.SIDE_LINGER_MS;
    this.emit();
  }

  /**
   * The doubt is cleared. The doubt page is KEPT — it holds an answer the
   * student may want to look back at — and both the camera and the write cursor
   * step back left onto the lesson page, which still holds everything taught
   * before the doubt and is where teaching carries on.
   */
  endDoubt() {
    this.doubtMode = false;
    this.plannedKind = "teach";
    this.sketchFrame = null;
    this.ephemeralLingerMs = BoardPlayer.EPHEMERAL_LINGER_MS;
    const back = this.returnIndex;
    this.returnIndex = -1;
    const home = back >= 0 ? this.pages[back] : undefined;
    if (home) {
      this.planAt(home);
      this.teachIndex = home.index;
      this.activeIndex = home.index;
      this.follow = true;
      this.showPage(home.index, { animate: true }); // emits
    } else {
      this.planAt(this.freshTeachSlot());
      this.follow = true;
      this.emit();
    }
  }

  /** Point the write cursor at a cell — an existing page, or a slot for one. */
  private planAt(slot: { index: number; row: number; col: number } | undefined) {
    if (!slot) return;
    this.plannedIndex = slot.index;
    this.plannedCell = { row: slot.row, col: slot.col };
  }

  /** The lowest row any page occupies; -1 while the book is empty. */
  private lastRow(): number {
    let row = -1;
    for (const p of this.pages) row = Math.max(row, p.row);
    return row;
  }

  /**
   * The cell a fresh TEACHING page takes: a new row at the head of column 0.
   *
   * The CURRENT teaching page is reused instead when nothing is on it — which
   * is what a step interrupted by a doubt leaves behind once its half-drawn
   * beat has been dropped. That reuse is the one thing that makes the lesson
   * carry on where it paused: it is keyed on the teaching page rather than on
   * the last page in the book, which after a doubt is the doubt's own page.
   */
  private freshTeachSlot(): { index: number; row: number; col: number } {
    const cur = this.teachIndex >= 0 ? this.pages[this.teachIndex] : undefined;
    if (cur && cur.kind === "teach" && !cur.used) return cur;
    return { index: this.pages.length, row: this.lastRow() + 1, col: 0 };
  }

  /**
   * The cell a doubt answer takes: the SAME ROW as the lesson page it
   * interrupts, one column further right. The teaching column stays unbroken,
   * and the way back from a doubt is one step left onto the very page the
   * lesson paused on.
   */
  private freshDoubtSlot(): { index: number; row: number; col: number } {
    const anchor = this.pages[this.teachIndex] ?? this.pages[this.activeIndex];
    const row = anchor ? anchor.row : 0;
    // Reuse only a doubt page in this row nothing was ever drawn on (a doubt
    // that came back as prose); every answered doubt gets a page of its own.
    const spare = this.pages.find((p) => p.kind === "doubt" && p.row === row && !p.used);
    if (spare) return spare;
    let col = 0;
    for (const p of this.pages) if (p.row === row) col = Math.max(col, p.col);
    return { index: this.pages.length, row, col: col + 1 };
  }

  /** The page the model is about to draw on, as the summary and prompt describe it. */
  pageFrame(): PageFrame {
    if (this.plannedIndex > this.pages.length) this.plannedIndex = this.pages.length;
    const index = this.plannedIndex;
    const { row, col } = this.pages[index] ?? this.plannedCell;
    return {
      ...cellRect(row, col),
      row,
      col,
      index,
      count: Math.max(this.pages.length, index + 1),
      kind: this.plannedKind,
    };
  }

  /** True while a doubt is being answered. */
  get inDoubtMode(): boolean {
    return this.doubtMode;
  }

  /** Pages drawn so far. */
  get pageCount(): number {
    return this.pages.length;
  }

  /**
   * The page `beginTeachTurn({ newStep: true })` would start on RIGHT NOW.
   *
   * Always a fresh page, matching `beginTeachTurn`: a step no longer shares the
   * page above it. The staged lesson reads this only to number the page in the
   * canvas header a step is generated against, and it is still a lower bound
   * rather than a promise — a step that spills onto a second page pushes every
   * later step down with it, so the real book ends up longer than the count
   * predicted here, never shorter.
   */
  nextTeachPage(): number {
    return this.freshTeachSlot().index;
  }

  // --- React bridge --------------------------------------------------------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** The CACHED snapshot. Never rebuild here: useSyncExternalStore would loop. */
  getPageState(): PageSnapshot {
    return this.snapshot;
  }

  private emit() {
    this.snapshot = {
      pages: this.pages.map((p) => ({
        index: p.index,
        row: p.row,
        col: p.col,
        kind: p.kind,
        used: p.used,
        rev: p.rev,
      })),
      activeIndex: this.activeIndex,
      viewIndex: this.framedIndex,
      follow: this.follow,
    };
    for (const fn of this.listeners) fn();
  }

  // --- allocation and bookkeeping -----------------------------------------

  private ensurePage(): Page {
    if (this.plannedIndex > this.pages.length) this.plannedIndex = this.pages.length;
    let p = this.pages[this.plannedIndex];
    if (!p) {
      const { row, col } = this.plannedCell;
      p = {
        ...cellRect(row, col),
        row,
        col,
        index: this.pages.length,
        kind: this.plannedKind,
        used: false,
        bottom: CONTENT_TOP,
        rev: 0,
        turnIds: new Map(),
        layout: freshPageLayout(),
        bodyPlaced: false,
        lastFigure: null,
        seenStudent: new Set(),
        spreadWith: null,
      };
      this.pages.push(p);
      this.plannedIndex = p.index;
    }
    this.activeIndex = p.index;
    if (p.kind === "teach") this.teachIndex = p.index;
    return p;
  }

  /** A fresh page of `kind` for a beat that ran past the one it started on:
   *  teaching carries on down its column, a doubt along its row. */
  private appendPage(kind: PageKind): Page {
    this.plannedKind = kind;
    if (kind === "doubt") {
      this.planAt(this.freshDoubtSlot());
      return this.ensurePage();
    }
    // A teaching page that runs over continues on the page to its RIGHT, and
    // the two are shown as one spread — unless that slot is taken (a second
    // overflow, or a doubt page already beside it), when the lesson carries on
    // down the column as a fresh single page.
    const head = this.pages[this.activeIndex];
    const slotFree = head && head.kind === "teach" && head.spreadWith == null && head.col === 0 && !this.pages.some((p) => p.row === head.row && p.col === 1);
    if (head && slotFree) {
      this.planAt({ index: this.pages.length, row: head.row, col: 1 });
      const next = this.ensurePage();
      head.spreadWith = next.index;
      next.spreadWith = head.index;
      return next;
    }
    this.planAt({ index: this.pages.length, row: this.lastRow() + 1, col: 0 });
    return this.ensurePage();
  }

  /** The scene rect the camera frames for a page: the page, or its two-page spread. */
  private viewRect(index: number): Rect {
    const p = this.pages[index];
    const partner = p?.spreadWith != null ? this.pages[p.spreadWith] : undefined;
    if (!p || !partner) return this.pageSceneRect(index);
    const x = Math.min(p.x, partner.x);
    const y = Math.min(p.y, partner.y);
    return { x, y, w: Math.max(p.x + p.w, partner.x + partner.w) - x, h: Math.max(p.y + p.h, partner.y + partner.h) - y };
  }

  private recordOnPage(i: number, turn: number, created: ExcalidrawElement[]) {
    const p = this.pages[i];
    if (!p) return;
    let ids = p.turnIds.get(turn);
    if (!ids) {
      ids = new Set();
      p.turnIds.set(turn, ids);
    }
    for (const e of created) ids.add(e.id);
    const keep = created.filter((e) => isPermanentNote(e));
    if (keep.length) {
      // Committed bounds: where the content actually landed.
      const [, , , y2] = getCommonBounds(keep);
      p.bottom = Math.max(p.bottom, y2 - p.y);
      p.used = true;
    }
    p.rev++;
    this.emit();
  }

  /** Book-keep what a beat drew, page by page: an anchored annotation may have
   *  landed on an earlier page than the one being written, and its bounds must
   *  not be read as that page's. */
  private recordCreated(turn: number, created: ExcalidrawElement[]) {
    const byPage = new Map<number, ExcalidrawElement[]>();
    for (const e of created) {
      const p = (e.customData as TutorMeta | undefined)?.page ?? this.activeIndex;
      const list = byPage.get(p) ?? [];
      list.push(e);
      byPage.set(p, list);
    }
    for (const [p, list] of byPage) this.recordOnPage(p, turn, list);
  }

  /**
   * Erase the elements one BEAT drew. A doubt can land in the middle of a beat,
   * and that beat is spoken again from its start when the lesson resumes — so
   * its half-drawn fragment has to come off the page first. Everything else the
   * step drew stays exactly where the student left it, which is what lets the
   * lesson carry on down the same page instead of starting over on a new one.
   */
  dropElements(ids: readonly string[]) {
    if (!ids.length) return;
    const set = new Set(ids);
    for (const p of this.pages) for (const s of p.turnIds.values()) for (const id of set) s.delete(id);
    this.deleteIds(set, true);
    for (const id of set) this.minted.delete(id);
    this.recomputePages();
    // The replay lays the beat out again from what is left on the page.
    this.sketchFrame = null;
    this.emit();
  }

  /**
   * Erase everything one turn drew. Used when a step has to be taught again from
   * the top (the model never finished it) — without this its half-drawn fragment
   * would be left under the replay.
   */
  dropTurn(turn: number) {
    const ids = new Set<string>();
    for (const p of this.pages) {
      const s = p.turnIds.get(turn);
      if (s) {
        for (const id of s) ids.add(id);
        p.turnIds.delete(turn);
      }
    }
    if (!ids.size) return;
    this.deleteIds(ids);
    this.recomputePages();
    this.emit();
  }

  /** Whether anything drawn for the model's id `id` is still on the board. */
  private isLive(id: string): boolean {
    const rid = this.idMap.get(id) ?? id;
    return this.all().some((e) => !e.isDeleted && (e.id === rid || (e.customData as TutorMeta | undefined)?.group === rid));
  }

  /** Re-derive every page's occupancy and layout state from what is actually left on the board. */
  private recomputePages() {
    const live = this.all().filter((e) => !e.isDeleted && isPermanentNote(e));
    for (const p of this.pages) {
      const mine = live.filter((e) => (e.customData as TutorMeta | undefined)?.page === p.index);
      if (!mine.length) {
        p.used = false;
        p.bottom = CONTENT_TOP;
        p.layout = freshPageLayout();
        p.bodyPlaced = false;
        p.lastFigure = null;
      } else {
        const [, , , y2] = getCommonBounds(mine);
        p.used = true;
        p.bottom = Math.max(CONTENT_TOP, y2 - p.y);
        // A float survives while any of what it framed does; the cursor sits
        // under everything else, so a replayed beat wraps beside the float.
        const floats = p.layout.floats.filter((f) => f.ids.some((id) => this.isLive(id)));
        const floatIds = new Set(floats.flatMap((f) => f.ids.map((id) => this.idMap.get(id) ?? id)));
        const inFloat = (e: ExcalidrawElement) => {
          const g = (e.customData as TutorMeta | undefined)?.group;
          return floatIds.has(e.id) || (g != null && floatIds.has(g));
        };
        const rest = mine.filter((e) => !inFloat(e));
        const restBottom = rest.length ? getCommonBounds(rest)[3] - p.y : CONTENT_TOP - CLEARANCE;
        p.layout = { cursorY: Math.max(CONTENT_TOP, restBottom + CLEARANCE), floats };
        p.bodyPlaced = mine.some((e) => !(e.customData as TutorMeta | undefined)?.fixed);
        if (p.lastFigure && !this.isLive(p.lastFigure)) p.lastFigure = null;
      }
      p.rev++;
    }
    for (const id of [...this.figures.keys()]) if (!this.isLive(id)) this.figures.delete(id);
  }

  /** Back to an empty book. Shared by the `clear` op and clearAll(). */
  private resetPages() {
    this.pages = [];
    this.plannedIndex = 0;
    this.plannedCell = { row: 0, col: 0 };
    this.plannedKind = "teach";
    this.activeIndex = -1;
    this.teachIndex = -1;
    this.returnIndex = -1;
    this.framedIndex = -1;
    this.doubtMode = false;
    this.follow = true;
    this.recenteredTurn = 0; // so the next beat takes the re-frame branch
    this.ephemeralLingerMs = BoardPlayer.EPHEMERAL_LINGER_MS;
    this.expandCache = new WeakMap();
    this.figures.clear();
    this.sketchFrame = null;
    this.emit();
    this.showPage(0, { animate: false });
  }

  /** This page's permanent content, for a thumbnail. */
  pageElements(index: number): readonly ExcalidrawElement[] {
    return this.all().filter((e) => {
      const m = e.customData as TutorMeta | undefined;
      return !e.isDeleted && !m?.temp && m?.page === index;
    });
  }

  pageSceneRect(index: number): Rect {
    const p = this.pages[index];
    return p ? { x: p.x, y: p.y, w: p.w, h: p.h } : pageRect(index);
  }

  // --- camera --------------------------------------------------------------
  //
  // Excalidraw's own scrollToContent / zoomToFitBounds floor the zoom to 0.1
  // steps, which can never frame a page exactly, so we do the maths ourselves
  // and write scrollX/scrollY/zoom straight onto appState.

  private fitRect(r: Rect) {
    const { width: W, height: H } = this.api.getAppState();
    return fitPage(r, W, H);
  }

  private writeView(v: { scrollX: number; scrollY: number; zoom: number }) {
    this.lastWrote = v;
    this.api.updateScene({
      appState: { scrollX: v.scrollX, scrollY: v.scrollY, zoom: { value: v.zoom as NormalizedZoomValue } },
      captureUpdate: CaptureUpdateAction.NEVER, // a page turn is not an edit to undo
    });
  }

  /** True when the viewport moved from somewhere other than our own last write. */
  private userMoved(tol = 0.5): boolean {
    const l = this.lastWrote;
    if (!l) return false;
    const s = this.api.getAppState();
    return (
      Math.abs(s.scrollX - l.scrollX) > tol ||
      Math.abs(s.scrollY - l.scrollY) > tol ||
      Math.abs(s.zoom.value - l.zoom) > 1e-4
    );
  }

  /**
   * Excalidraw's onChange. A viewport we did not write, with no tween in flight
   * to explain it, means the student grabbed the canvas and is reading
   * somewhere of their own choosing — so Indica stops dragging the camera after
   * them and the board's "Scroll back to content" button appears.
   *
   * `lastWrote` is then dropped: the viewport is theirs now, not ours, so the
   * next animated move measures itself against where they left it instead of
   * mistaking their pan for a grab. The tolerance is slack for the rounding
   * Excalidraw does to what it stores.
   */
  notifyViewport() {
    if (this.tween != null || !this.lastWrote) return;
    if (!this.userMoved(2)) return;
    this.lastWrote = null;
    if (!this.follow) return;
    this.follow = false;
    this.emit();
  }

  /**
   * Frame a page. `manual` marks a student-driven move: the camera then stops
   * following Indica until they come back to the page she is writing on, so
   * browsing to an earlier page is not undone by the very next beat.
   */
  showPage(index: number, opts?: { animate?: boolean; manual?: boolean }) {
    const to = this.fitRect(this.viewRect(index));
    if (!to) return;
    this.framedIndex = index;
    if (opts?.manual) this.follow = index === this.activeIndex;
    this.emit();
    if (this.tween != null) {
      cancelAnimationFrame(this.tween);
      this.tween = null;
    }
    if (!opts?.animate) {
      this.writeView(to);
      return;
    }
    const s = this.api.getAppState();
    const from = { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value };
    // The grab test below compares the live viewport against our own last
    // write. This tween starts from wherever the viewport is NOW, so that is
    // the baseline. Without this line any move we did not make — a student pan,
    // Excalidraw's own scroll-back button, a resize — reads as a grab on the
    // very FIRST frame: the camera gives up before it has moved at all and
    // latches `follow` off, so from then on page turns only change the page
    // number and Indica writes off-screen for the rest of the session.
    this.lastWrote = from;
    const t0 = performance.now();
    const step = (now: number) => {
      // The student grabbed the canvas mid-flight: let them have it.
      if (this.userMoved()) {
        this.tween = null;
        this.follow = false;
        this.emit();
        return;
      }
      const t = Math.min(1, (now - t0) / TWEEN_MS);
      const e = 1 - Math.pow(1 - t, 3);
      this.writeView({
        scrollX: from.scrollX + (to.scrollX - from.scrollX) * e,
        scrollY: from.scrollY + (to.scrollY - from.scrollY) * e,
        zoom: from.zoom * Math.pow(to.zoom / from.zoom, e), // geometric, as Excalidraw interpolates
      });
      this.tween = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.tween = requestAnimationFrame(step);
  }

  /** Re-frame the current page without animating — after a container resize. */
  refit() {
    this.showPage(this.framedIndex >= 0 ? this.framedIndex : 0, { animate: false });
  }

  /** Jump back to the page Indica is writing on ("Back to Indica"). */
  recenter() {
    this.showPage(this.activeIndex >= 0 ? this.activeIndex : 0, { animate: true, manual: true });
  }

  /** Follow the writing onto `page` once per turn, and whenever the page changes. */
  private frameForWriting(page: Page, turn: number) {
    if (this.follow && (page.index !== this.framedIndex || turn !== this.recenteredTurn)) {
      this.recenteredTurn = turn;
      this.showPage(page.index, { animate: true }); // navigate, THEN draw
    }
  }

  private all(): readonly OrderedExcalidrawElement[] {
    return this.api.getSceneElementsIncludingDeleted();
  }

  private commit(elements: readonly ExcalidrawElement[]) {
    this.api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
  }

  /** Replace one element (by id) in the scene and commit. */
  private patch(updated: ExcalidrawElement) {
    this.commit(this.all().map((e) => (e.id === updated.id ? updated : e)));
  }

  /**
   * A scene id for the model's own id, unique against EVERY id the board has
   * ever held.
   *
   * It used to check only the ids of elements that are not deleted — but
   * `commit` rebuilds the scene from `getSceneElementsIncludingDeleted()`, so
   * an id belonging to a soft-deleted element is still in the array. Handing it
   * out again made `typeText`/`growLine`/`fadeIn` append a SECOND element with
   * that id, and Excalidraw's fractional-index invariant threw. A doubt made
   * this routine: `dropElements` deletes the interrupted beat and the replay
   * immediately asks for its ids back.
   *
   * `minted` covers ids handed out earlier in this same beat, which are not in
   * the scene yet, and ids whose elements have since been purged outright.
   */
  private resolveId(llmId: string | null | undefined): string {
    const base = (llmId || "el").replace(/[^a-zA-Z0-9_-]/g, "_");
    const taken = new Set(this.all().map((e) => e.id));
    let candidate = base;
    let n = 2;
    while (taken.has(candidate) || this.minted.has(candidate)) candidate = `${base}_${n++}`;
    this.minted.add(candidate);
    if (llmId) this.idMap.set(llmId, candidate);
    return candidate;
  }

  /**
   * Erase elements by id. `purge` drops them from the scene array outright
   * instead of leaving a tombstone: used for content that is about to be drawn
   * again, where a tombstone is pure debris — it would pile up one beat per
   * doubt and keep pushing the replay's ids onto ever longer suffixes.
   */
  private deleteIds(ids: Set<string>, purge = false) {
    const hit = (e: ExcalidrawElement) => {
      const group = (e.customData as { group?: string } | undefined)?.group;
      return (
        ids.has(e.id) ||
        (group != null && ids.has(group)) || // erase the whole primitive by its parent id
        ("containerId" in e && e.containerId != null && ids.has(e.containerId))
      );
    };
    this.commit(
      purge
        ? this.all().filter((e) => !hit(e))
        : this.all().map((e) => (hit(e) && !e.isDeleted ? newElementWith(e, { isDeleted: true }) : e)),
    );
  }

  // --- furniture -------------------------------------------------------------

  /**
   * Write a step's heading at the very top of its page, then set the cursor
   * under it so the step's own beats flow beneath the rule. The page's layout
   * state is reset first: a page is reused after `dropTurn`, and the heading
   * must not land under whatever the abandoned attempt left in the cursor.
   */
  async drawStepHeading(ops: DrawOp[], turn: number, signal: AbortSignal): Promise<ExcalidrawElement[]> {
    return this.drawFurniture(ops, turn, signal);
  }

  /**
   * Draw a solve turn's server-laid question block, then keep the model's
   * solution below it. The question is written deterministically
   * (question-board.ts) at fixed coordinates; the cursor is then set under its
   * real, post-layout bottom, so no beat can land on it whatever the model
   * imagined about the page.
   */
  async drawQuestionBlock(ops: DrawOp[], turn: number, signal: AbortSignal): Promise<ExcalidrawElement[]> {
    return this.drawFurniture(ops, turn, signal);
  }

  private async drawFurniture(ops: DrawOp[], turn: number, signal: AbortSignal): Promise<ExcalidrawElement[]> {
    const page = this.ensurePage();
    page.layout = freshPageLayout();
    page.bodyPlaced = false;
    const created = await this.applyBeat(
      ops.map((o) => ({ ...o, layout: "fixed" as const })),
      turn,
      signal,
    );
    if (created.length) page.layout.cursorY = Math.max(page.layout.cursorY, page.bottom + HEADING_GAP);
    return created;
  }

  // --- beats ---------------------------------------------------------------

  /**
   * Applies a beat's ops in order. Resolves when all animation is done or the
   * signal aborts.
   *
   * The beat is split into blocks, laid out by the flow engine against the
   * page's current state (continuing onto fresh pages as needed), and drawn at
   * the positions the engine returns. Ops that annotate a figure by name are
   * resolved against the registry and drawn on that figure's page.
   */
  async applyBeat(ops: DrawOp[], turn: number, signal: AbortSignal): Promise<ExcalidrawElement[]> {
    this.currentTurn = turn;
    // Lay nothing out until the board font can be measured: on a cold page
    // Excalifont is still loading, and widths measured against a substitute
    // wrap lines and place labels wrongly.
    await fontsReady();
    if (signal.aborted) return [];
    // Rewrite any Unicode "x²"/"H₂O" the model slipped in into ^/_ notation, so
    // it is laid out as real raised type instead of rendering as mojibake.
    ops = ops.map(normalizeBoardText);
    ops = ops.flatMap((o) => this.dedupeFigure(o, turn));
    const raw = groupBlocks(ops);
    for (const b of raw) if (b.kind === "control") this.applyControl(b.op);
    const flow = raw.filter(
      (b): b is Extract<RawBlock, { kind: "text" | "figure" | "sketch" | "fixed" }> =>
        b.kind === "text" || b.kind === "figure" || b.kind === "sketch" || b.kind === "fixed",
    );
    const anchored = raw.filter((b): b is Extract<RawBlock, { kind: "anchored" }> => b.kind === "anchored");
    for (const b of raw) {
      if (b.kind === "gesture") console.warn("[board] dropped a pointing gesture with nothing to point at", b.op);
    }
    // erase/clear-only beats (and a beat with no draw ops at all) must not
    // allocate a page or move the camera, or an answer given in words alone
    // would leave a blank page behind.
    if (!flow.length && !anchored.length) return [];

    const created: ExcalidrawElement[] = [];
    if (flow.length) {
      const page = this.ensurePage();
      this.absorbStudentContent(page);
      const blocks: Block[] = flow.map((b, i) => {
        if (b.kind === "text") return textBlockOf(b.op, i);
        const ops = b.kind === "figure" ? b.ops.map(readableSize) : b.ops;
        const bbox = this.measureOps(ops);
        const scalable = ops.every((o) => SCALABLE_OPS.has(o.op) || o.op === "text");
        const gestureOnly = b.kind === "sketch" && ops.every(isGesture);
        return { kind: b.kind, index: i, ops, bbox, scalable, place: ops[0]?.place ?? null, gestureOnly } satisfies BoxBlock;
      });
      const frame =
        this.sketchFrame && this.sketchFrame.turn === turn && this.sketchFrame.page === page.index
          ? this.sketchFrame.frame
          : null;
      const res = layoutBeat(blocks, page.layout, frame, (t, px) => measureText(t, px), { startsFresh: !page.bodyPlaced });
      const targets: Page[] = [page];
      for (let k = 1; k < res.pages.length; k++) targets.push(this.appendPage(page.kind));
      res.pages.forEach((st, k) => {
        targets[k].layout = st;
      });
      const last = targets[targets.length - 1];
      this.sketchFrame = res.frame ? { turn, page: last.index, frame: res.frame } : null;

      let shown: Page | null = null;
      for (const p of res.placements) {
        if (signal.aborted) break;
        const target = targets[p.page];
        if (target !== shown) {
          this.frameForWriting(target, turn);
          shown = target;
        }
        const block = blocks[p.index];
        try {
          if (p.kind === "text" && block.kind === "text") created.push(...(await this.drawTextAt(block, p, target, turn, signal)));
          else if (p.kind === "box" && block.kind !== "text") created.push(...(await this.drawBoxAt(block, p, target, turn, signal)));
        } catch (err) {
          console.warn("[board] failed block", block, err);
        }
        if (block.kind !== "fixed") target.bodyPlaced = true;
        await sleep(60, signal);
      }
      // The write cursor stays on the page the beat ended on.
      this.activeIndex = last.index;
      if (last.kind === "teach") this.teachIndex = last.index;
      this.planAt(last);
    }
    for (const b of anchored) {
      if (signal.aborted) break;
      try {
        created.push(...(await this.drawAnchored(b.op, turn, signal, !flow.length)));
      } catch (err) {
        console.warn("[board] failed annotation", b.op, err);
      }
      await sleep(60, signal);
    }
    if (created.length) this.recordCreated(turn, created);
    return created;
  }

  private applyControl(op: DrawOp) {
    if (op.op === "clear") {
      this.cancelEphemeralFades();
      const next = this.all().map((e) => (e.isDeleted ? e : newElementWith(e, { isDeleted: true })));
      this.commit(next);
      this.idMap.clear();
      this.minted.clear();
      this.resetPages(); // board wiped: back to a single blank first page
      return;
    }
    if (op.op === "erase") {
      const ids = new Set<string>();
      for (const id of op.ids ?? []) ids.add(this.idMap.get(id) ?? id);
      this.deleteIds(ids);
      this.recomputePages();
    }
  }

  /**
   * Fold the student's own strokes on this page into its layout state, so a
   * reply beside their work lands beside it: a sketch on the right half is a
   * float the notes wrap around, anything else pushes the cursor below it.
   */
  private absorbStudentContent(page: Page) {
    for (const e of this.all()) {
      if (e.isDeleted || (e.customData as TutorMeta | undefined)?.tutor) continue;
      if (page.seenStudent.has(e.id) || this.pageOf(e) !== page.index) continue;
      page.seenStudent.add(e.id);
      const [x1, y1, x2, y2] = getCommonBounds([e]);
      const r = { x: x1 - page.x, y: y1 - page.y, w: x2 - x1, h: y2 - y1 };
      if (r.x > PAGE_W / 2) page.layout.floats.push({ rect: r, ids: [e.id] });
      else page.layout.cursorY = Math.max(page.layout.cursorY, r.y + r.h + CLEARANCE);
    }
  }

  /** Expand a primitive once and reuse it: measuring and drawing agree. */
  private expand(op: DrawOp): Expanded {
    let e = this.expandCache.get(op as object);
    if (!e) {
      e = expandPrimitive(op) ?? expandMathText(op);
      this.expandCache.set(op as object, e);
    }
    return e;
  }

  /**
   * The box a set of ops WOULD occupy, in their own coordinates, before any
   * placement. Built from real converted elements rather than measure.ts
   * (which sizes a stand-in font) or `e.y + e.height` (wrong for an arrow
   * drawn upward).
   */
  private measureOps(ops: DrawOp[]): Rect {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    const add = (ax1: number, ay1: number, ax2: number, ay2: number) => {
      x1 = Math.min(x1, ax1);
      y1 = Math.min(y1, ay1);
      x2 = Math.max(x2, ax2);
      y2 = Math.max(y2, ay2);
    };
    for (const op of ops) {
      if (PRIMITIVES[op.op] || isMathText(op)) {
        const ex = this.expand(op);
        // The declared bbox carries padding the children do not report; the
        // children are exact where the bbox under-covers. Use both.
        add(ex.bbox.x, ex.bbox.y, ex.bbox.x + ex.bbox.w, ex.bbox.y + ex.bbox.h);
        for (const c of ex.ops) this.measureLow(c, add);
      } else {
        this.measureLow(op, add);
      }
    }
    if (!Number.isFinite(x1)) return { x: ops[0]?.x ?? 0, y: ops[0]?.y ?? 0, w: 1, h: 1 };
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  private measureLow(op: DrawOp, add: (x1: number, y1: number, x2: number, y2: number) => void) {
    const skel = opToSkeleton(op, 0, "__measure__");
    if (!skel) return;
    const els = convertToExcalidrawElements([skel], { regenerateIds: false });
    if (!els.length) return;
    const [x1, y1, x2, y2] = getCommonBounds(els);
    add(x1, y1, x2, y2);
  }

  /** A text block at the position the engine gave it (wrapped, maybe one part of a split). */
  private async drawTextAt(
    block: TextBlock,
    p: Extract<Placement, { kind: "text" }>,
    page: Page,
    turn: number,
    signal: AbortSignal,
  ): Promise<ExcalidrawElement[]> {
    const op: DrawOp = { ...block.op, x: p.x, y: p.y, text: p.lines.join("\n") };
    if (block.math) {
      const ex = expandMathText(op);
      return this.drawGroup(ex.ops, this.resolveId(op.id), ex.label, page, turn, signal);
    }
    return this.drawFree(op, page, turn, signal);
  }

  /** A figure, sketch or fixed block at the position the engine gave it. */
  private async drawBoxAt(
    block: BoxBlock,
    p: Extract<Placement, { kind: "box" }>,
    page: Page,
    turn: number,
    signal: AbortSignal,
  ): Promise<ExcalidrawElement[]> {
    let ops = block.ops;
    let bbox = block.bbox;
    if (p.scale !== 1) {
      ops = ops.map((o) => scaleOp(o, p.scale));
      bbox = this.measureOps(ops);
    }
    // Labels keep their size when a figure shrinks, so the real box can be a
    // little wider than the engine's estimate: keep it inside the page.
    const px = Math.max(CONTENT_LEFT, Math.min(p.x, CONTENT_RIGHT - bbox.w));
    const dx = px - bbox.x;
    const dy = p.y - bbox.y;
    if (block.kind === "sketch") ops = this.spreadSketchText(ops);
    const created: ExcalidrawElement[] = [];
    for (const op of ops) {
      if (signal.aborted) break;
      if (PRIMITIVES[op.op]) {
        const ex = this.expand(op);
        const groupId = this.resolveId(op.id);
        created.push(...(await this.drawGroup(ex.ops.map((c) => shiftOp(c, dx, dy)), groupId, ex.label, page, turn, signal)));
        if (ex.anchors) {
          const id = op.id ?? groupId;
          const labelBoxes = ex.ops
            .filter((c) => c.op === "text")
            .map((c) => {
              let r: Rect = { x: 0, y: 0, w: 0, h: 0 };
              this.measureLow(shiftOp(c, dx, dy), (x1, y1, x2, y2) => (r = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }));
              return r;
            });
          this.figures.set(id, { id, page: page.index, turn, anchors: transformAnchors(ex.anchors, 1, dx, dy), labelBoxes, markedVertices: [], segments: [] });
          page.lastFigure = id;
        }
      } else if (isMathText(op)) {
        const ex = expandMathText(shiftOp(op, dx, dy));
        created.push(...(await this.drawGroup(ex.ops, this.resolveId(op.id), ex.label, page, turn, signal)));
      } else {
        created.push(...(await this.drawFree(shiftOp(op, dx, dy), page, turn, signal)));
      }
      await sleep(40, signal);
    }
    return created;
  }

  /**
   * The text labels of a free-form sketch, nudged apart where the model gave
   * two of them the same spot. Shapes and lines stay exactly where they were
   * drawn — only a label that would print over an earlier label moves, and only
   * downward, by the overlap. The one hand-placed case the flow layout cannot
   * see inside.
   */
  private spreadSketchText(ops: DrawOp[]): DrawOp[] {
    const placed: Rect[] = [];
    return ops.map((op) => {
      if (op.op !== "text" || !op.text) return op;
      let box: Rect = { x: op.x ?? 0, y: op.y ?? 0, w: 0, h: 0 };
      this.measureLow(op, (x1, y1, x2, y2) => (box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }));
      let shift = 0;
      for (let pass = 0; pass < 6; pass++) {
        const hit = placed.find(
          (r) => box.x < r.x + r.w + 4 && box.x + box.w > r.x - 4 && box.y + shift < r.y + r.h + 4 && box.y + shift + box.h > r.y - 4,
        );
        if (!hit) break;
        shift = hit.y + hit.h + 6 - box.y;
      }
      placed.push({ ...box, y: box.y + shift });
      return shift ? { ...op, y: (op.y ?? 0) + shift } : op;
    });
  }

  /**
   * A polygon with the same labelled vertices as one already on this page is
   * the same figure drawn again — the model does this when it wants to add
   * side labels, despite being told to annotate. The copy is not drawn; its
   * side labels become anchored labels on the figure that is already there.
   */
  private dedupeFigure(op: DrawOp, turn: number): DrawOp[] {
    if (op.op !== "polygon" || !op.points || op.points.length < 3) return [op];
    const labels = op.points.map((p) => (p.label ?? "").trim());
    if (labels.some((l) => !l)) return [op];
    const key = labels.join("");
    const page = this.activeIndex;
    const existing = [...this.figures.values()].reverse().find((f) => {
      // The same step, or the same page (a doubt annotating the lesson's figure).
      if (f.turn !== turn && f.page !== page) return false;
      const names = Object.keys(f.anchors.vertexIndex).filter((n) => !/^v\d+$/.test(n));
      return names.length === labels.length && names.join("") === key;
    });
    if (!existing) return [op];
    console.warn(`[board] figure ${key} is already on this page; its side labels are added to it instead`, op);
    const out: DrawOp[] = [];
    (op.sides ?? []).forEach((side, i) => {
      const t = (side ?? "").trim();
      if (!t) return;
      out.push({ op: "text", id: op.id ? `${op.id}.s${i}` : undefined, at: `${labels[i]}${labels[(i + 1) % labels.length]}`, of: existing.id, text: t, color: "blue" });
    });
    return out;
  }

  /** The elements drawn for a model id (an op, or a whole primitive by its group). */
  private elementsFor(modelId: string): ExcalidrawElement[] {
    const rid = this.idMap.get(modelId) ?? modelId;
    return this.all().filter((e) => !e.isDeleted && (e.id === rid || (e.customData as TutorMeta | undefined)?.group === rid));
  }

  /**
   * An op that names what it belongs to: an angle at a vertex, a label beside
   * a side, a highlight on a side or over an element, a construction line
   * between two named points, a pointer at an element. Resolved against the
   * committed geometry and drawn on that content's page; a name that resolves
   * to nothing is dropped, never guessed.
   */
  private async drawAnchored(op: DrawOp, turn: number, signal: AbortSignal, frameIt: boolean): Promise<ExcalidrawElement[]> {
    const targetId = op.at ?? op.to ?? null;
    // Pointing at an element the board already holds, by its id.
    if (targetId && (op.op === "highlight" || op.op === "arrow") && !op.from) {
      const els = this.elementsFor(targetId);
      if (els.length) {
        const page = this.pages[this.pageOf(els[0])];
        if (!page) return [];
        const [x1, y1, x2, y2] = getCommonBounds(els);
        const b = { x: x1 - page.x, y: y1 - page.y, w: x2 - x1, h: y2 - y1 };
        const d = op.op === "highlight" ? elementHighlight(b, op) : pointerArrow(b, op);
        if (frameIt) this.frameForWriting(page, turn);
        return this.drawFree(d, page, turn, signal);
      }
    }
    const ref = splitAnchorRef(op.at ?? "");
    const figId = op.of ?? ref.of ?? this.pages[this.activeIndex]?.lastFigure ?? this.latestFigureId();
    const fig = figId ? this.figures.get(figId) : undefined;
    if (!fig) {
      console.warn("[board] annotation names no figure on the board", op);
      return [];
    }
    // A construction line may join two figures on the same page (a line of
    // sight from the eye in one triangle to the treetop in another): each end
    // is looked up in the named figure first, then in the page's other figures.
    if ((op.op === "line" || op.op === "arrow" || op.op === "curvearrow") && op.from && op.to) {
      const a = this.resolveAcross(op.from, fig);
      const b = this.resolveAcross(op.to, fig);
      if (a && b && a.fig.page === b.fig.page) {
        const page = this.pages[a.fig.page];
        if (!page) return [];
        if (frameIt) this.frameForWriting(page, turn);
        const d: DrawOp = {
          op: op.op === "arrow" ? "arrow" : "line",
          id: op.id ?? undefined,
          x: a.pt.x,
          y: a.pt.y,
          x2: b.pt.x,
          y2: b.pt.y,
          color: op.color ?? "red",
          dash: op.dash ?? undefined,
          temp: op.temp ?? false, // a construction on a figure is notes unless the model says otherwise
        };
        if (a.fig === b.fig) a.fig.segments.push([a.pt, b.pt]);
        const drawn = await this.drawFree(d, page, turn, signal);
        // Its text goes beside the midpoint, clear of the figure and of every
        // label already on it, and is remembered so later labels avoid it.
        const lbl = op.text ? segmentLabel(a.fig, a.pt, b.pt, { id: op.id, text: op.text, color: op.color ?? "blue" }) : null;
        if (lbl) {
          a.fig.labelBoxes.push(lbl.box);
          drawn.push(...(await this.drawGroup(lbl.ops, this.resolveId(lbl.ops[0].id), lbl.label, page, turn, signal)));
        }
        return drawn;
      }
      console.warn("[board] construction line names a point no figure on the page has", op);
      return [];
    }
    const page = this.pages[fig.page];
    if (!page) return [];
    if (frameIt) this.frameForWriting(page, turn);
    switch (op.op) {
      case "angle": {
        const ex = anchoredAngle(fig, ref.name, op);
        if (!ex) break;
        fig.markedVertices.push(ref.name.trim());
        if (ex.box) fig.labelBoxes.push(ex.box);
        return this.drawGroup(ex.ops, this.resolveId(op.id), ex.label, page, turn, signal);
      }
      case "text": {
        // "hypotenuse" goes opposite the right angle, "opposite"/"adjacent"
        // follow the marked angle — whichever side the model named.
        const r = anchoredLabel(fig, retargetSide(fig, ref.name, op.text ?? ""), op);
        if (!r) break;
        fig.labelBoxes.push(r.box);
        return this.drawGroup(r.ops, this.resolveId(op.id), r.label, page, turn, signal);
      }
      case "highlight": {
        const d = anchoredHighlight(fig, ref.name, op);
        if (!d) break;
        return this.drawFree(d, page, turn, signal);
      }
      default:
        break;
    }
    console.warn("[board] annotation names a part the figure does not have", op);
    return [];
  }

  /** A named point in `preferred`, else in the most recent other figure on its page that has it. */
  private resolveAcross(name: string, preferred: Figure): { fig: Figure; pt: Pt } | null {
    const ref = splitAnchorRef(name);
    const named = ref.of ? this.figures.get(ref.of) : undefined;
    const order = [named, preferred, ...[...this.figures.values()].reverse().filter((f) => f.page === preferred.page)];
    for (const f of order) {
      if (!f) continue;
      const pt = resolvePoint(f, ref.name);
      if (pt) return { fig: f, pt };
    }
    return null;
  }

  private latestFigureId(): string | null {
    let last: string | null = null;
    for (const id of this.figures.keys()) last = id;
    return last;
  }

  /**
   * Draw one free-standing op at page-local coordinates. A bare `arrow` op is
   * a pointing gesture by default: it fades on its own unless the model marks
   * it permanent (temp:false).
   */
  private async drawFree(opIn: DrawOp, page: Page, turn: number, signal: AbortSignal): Promise<ExcalidrawElement[]> {
    const ephemeral = isGesture(opIn);
    let op = ephemeral !== Boolean(opIn.temp) ? { ...opIn, temp: ephemeral } : opIn;
    // Excalidraw binds a label to an arrow but not to a plain line, so a line's
    // text ("line of sight") is written beside its midpoint as its own element.
    let sideLabel: DrawOp | null = null;
    if (op.op === "line" && op.text && typeof op.x === "number" && typeof op.y === "number") {
      const x2 = op.x2 ?? op.x + 120;
      const y2 = op.y2 ?? op.y;
      const dx = x2 - op.x;
      const dy = y2 - op.y;
      const len = Math.hypot(dx, dy) || 1;
      // Square to the line, on the upper side; the box is centred on that point.
      let nx = dy / len;
      let ny = -dx / len;
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      const w = measureText(op.text, 16);
      const off = 10 + Math.abs(nx) * (w / 2) + Math.abs(ny) * 10;
      const mx = (op.x + x2) / 2 + nx * off;
      const my = (op.y + y2) / 2 + ny * off;
      sideLabel = { op: "text", id: op.id ? `${op.id}.t` : undefined, x: mx - w / 2, y: my - 10, text: op.text, size: "sm", color: op.color, temp: op.temp };
      op = { ...op, text: undefined };
    }
    const elementId = this.resolveId(op.id);
    const skeleton = opToSkeleton(shiftOp(op, page.x, page.y), turn, elementId, page.index);
    if (!skeleton) return [];
    const converted = convertToExcalidrawElements([skeleton], { regenerateIds: false });
    if (!converted.length) return [];
    // Shapes with labels come back as [container, boundText].
    const rest = converted.slice(1);
    const primary = converted[0];
    if (primary.type === "text") {
      await this.typeText(primary as ExcalidrawTextElement, signal);
    } else if (primary.type === "arrow" || primary.type === "line") {
      await this.growLine(primary as ExcalidrawLinearElement, rest, signal);
    } else {
      await this.fadeIn(primary, rest, signal);
    }
    // Transient pointing gestures linger briefly, then gracefully fade and remove
    // themselves — so repeated "look here" arrows never pile up on the board.
    if (op.temp) this.scheduleEphemeralFade([primary.id, ...rest.map((e) => e.id)]);
    const label = sideLabel ? await this.drawFree(sideLabel, page, turn, signal) : [];
    return [primary, ...rest, ...label];
  }

  /**
   * Draw the children of a primitive (or of a scripted text line) at page-local
   * coordinates, tagged with one group id so the summary collapses them, an
   * erase removes them together, and `isLive` can find them.
   */
  private async drawGroup(
    children: DrawOp[],
    groupId: string,
    label: string,
    page: Page,
    turn: number,
    signal: AbortSignal,
  ): Promise<ExcalidrawElement[]> {
    const created: ExcalidrawElement[] = [];
    for (const child of children) {
      if (signal.aborted) break;
      const base = opToSkeleton(shiftOp(child, page.x, page.y), turn, this.resolveId(child.id), page.index);
      if (!base) continue;
      const skel = { ...base, customData: { ...(base.customData as object), group: groupId, groupLabel: label } };
      const converted = convertToExcalidrawElements([skel], { regenerateIds: false });
      if (!converted.length) continue;
      const rest = converted.slice(1);
      const primary = converted[0];
      if (primary.type === "text") {
        await this.typeText(primary as ExcalidrawTextElement, signal);
      } else if (primary.type === "arrow" || primary.type === "line") {
        // Short segments (ticks, arcs, radical strokes) snap in instantly; a long axis grows.
        if (Math.abs(primary.width) + Math.abs(primary.height) <= 24) this.placeInstant(primary, rest);
        else await this.growLine(primary as ExcalidrawLinearElement, rest, signal);
      } else {
        await this.fadeIn(primary, rest, signal);
      }
      if (child.temp) this.scheduleEphemeralFade([primary.id, ...rest.map((e) => e.id)]);
      created.push(primary, ...rest);
      await sleep(18, signal); // snappier than free-form ops — a group has many children
    }
    return created;
  }

  /** Commit an element (and any bound children) at full opacity, no animation. */
  private placeInstant(el: ExcalidrawElement, bound: ExcalidrawElement[]) {
    this.commit([...this.all(), el, ...bound]);
  }

  /** The page an element belongs to — its tag, or its grid cell as a last resort. */
  private pageOf(e: ExcalidrawElement): number {
    const p = (e.customData as TutorMeta | undefined)?.page;
    if (typeof p === "number") return p;
    const { row, col } = cellAtScene(e.x + e.width / 2, e.y + e.height / 2);
    return this.pages.find((q) => q.row === row && q.col === col)?.index ?? 0;
  }

  /** Text: insert with empty text, then reveal characters. */
  private async typeText(el: ExcalidrawTextElement, signal: AbortSignal) {
    const full = el.text;
    const perChar = clamp(900 / Math.max(full.length, 1), 10, 35);
    this.commit([...this.all(), newElementWith(el, { text: "", originalText: "" })]);
    let i = 0;
    while (i < full.length) {
      if (signal.aborted) break;
      i = Math.min(full.length, i + (full.length > 60 ? 2 : 1));
      const part = full.slice(0, i);
      this.patch(newElementWith(el, { text: part, originalText: part }));
      await sleep(perChar, signal);
    }
    this.patch(el);
  }

  /** Arrows/lines: grow from the start point to the end point. */
  private async growLine(el: ExcalidrawLinearElement, bound: ExcalidrawElement[], signal: AbortSignal) {
    const [, end] = el.points;
    const steps = 7;
    const start = newElementWith(el, {
      points: [
        [0, 0],
        [0, 0],
      ] as ExcalidrawLinearElement["points"],
      width: 0,
      height: 0,
    });
    this.commit([...this.all(), start]);
    for (let s = 1; s <= steps; s++) {
      if (signal.aborted) break;
      const t = s / steps;
      this.patch(
        newElementWith(el, {
          points: [
            [0, 0],
            [end[0] * t, end[1] * t],
          ] as ExcalidrawLinearElement["points"],
          width: Math.abs(end[0] * t),
          height: Math.abs(end[1] * t),
        }),
      );
      await sleep(35, signal);
    }
    this.commit([...this.all().filter((e) => e.id !== el.id), el, ...bound]);
  }

  /** Shapes: fade in over a few frames, then add their label. */
  private async fadeIn(el: ExcalidrawElement, bound: ExcalidrawElement[], signal: AbortSignal) {
    const target = el.opacity;
    const frames = [0.2, 0.5, 0.8, 1];
    this.commit([...this.all(), newElementWith(el, { opacity: Math.round(target * frames[0]) })]);
    for (const f of frames.slice(1)) {
      if (signal.aborted) break;
      this.patch(newElementWith(el, { opacity: Math.round(target * f) }));
      await sleep(40, signal);
    }
    this.commit([...this.all().filter((e) => e.id !== el.id), el, ...bound]);
  }

  /**
   * How long a transient annotation stays fully visible before it fades. The base
   * value is a touch generous so "look here" arrows are readable; doubt answers on
   * the side canvas use the longer SIDE value, since a confused student re-reads
   * the pointer more slowly. `ephemeralLingerMs` is the live value (set per mode).
   */
  private static EPHEMERAL_LINGER_MS = 4000;
  private static SIDE_LINGER_MS = 9000;
  private ephemeralLingerMs = BoardPlayer.EPHEMERAL_LINGER_MS;

  /** After a linger, fade the given elements out and delete them. Detached from the turn. */
  private scheduleEphemeralFade(ids: string[]) {
    if (!ids.length) return;
    const timer = setTimeout(() => {
      this.ephemeralTimers.delete(timer);
      void this.fadeOutAndDelete(new Set(ids));
    }, this.ephemeralLingerMs);
    this.ephemeralTimers.add(timer);
  }

  /** Gracefully fade the matching elements to nothing, then mark them deleted. */
  private async fadeOutAndDelete(ids: Set<string>) {
    // Remember each element's starting opacity so the fade is proportional.
    const base = new Map<string, number>();
    for (const e of this.all()) if (ids.has(e.id) && !e.isDeleted) base.set(e.id, e.opacity);
    if (!base.size) return;
    for (const f of [0.6, 0.3, 0]) {
      if (![...base.keys()].some((id) => this.all().some((e) => e.id === id && !e.isDeleted))) return;
      this.commit(
        this.all().map((e) =>
          base.has(e.id) && !e.isDeleted ? newElementWith(e, { opacity: Math.round(base.get(e.id)! * f) }) : e,
        ),
      );
      await sleep(130);
    }
    this.deleteIds(ids);
  }

  /** Cancel any pending transient fades (board is being wiped). */
  private cancelEphemeralFades() {
    for (const t of this.ephemeralTimers) clearTimeout(t);
    this.ephemeralTimers.clear();
  }

  /** Marks everything as deleted (used by the "New topic" button). */
  clearAll() {
    this.cancelEphemeralFades();
    const next = this.all().map((e) => (e.isDeleted ? e : newElementWith(e, { isDeleted: true })));
    this.commit(next);
    this.idMap.clear();
    this.minted.clear();
    this.resetPages();
  }
}

/**
 * A copy of the op with Unicode script characters in its text rewritten to the
 * `^`/`_` notation the layout understands. Only `text` ops get the full raised
 * treatment; a shape or arrow LABEL is bound text that Excalidraw owns, which
 * cannot hold runs of two sizes, so its scripts are flattened to ordinary
 * characters ("x²" -> "x2") — plain, but readable, which mojibake is not.
 */
function normalizeBoardText(opIn: DrawOp): DrawOp {
  let op = opIn;
  if (op.rows) op = { ...op, rows: op.rows.map((r) => r.map((c) => symbolsForWords(String(c ?? "")))) };
  if (op.sides) op = { ...op, sides: op.sides.map((s) => symbolsForWords(String(s ?? ""))) };
  if (!op.text) return op;
  const text = symbolsForWords(op.text);
  if (op.op === "text") {
    const scripted = HAS_UNICODE_SCRIPT.test(text) ? normalizeScripts(text) : text;
    return scripted === op.text ? op : { ...op, text: scripted };
  }
  // A label: flatten both notations so neither a stray caret nor a missing
  // glyph is drawn literally inside the shape.
  const flat = flattenMath(normalizeScripts(text));
  return flat === op.text ? op : { ...op, text: flat };
}


const HAS_UNICODE_SCRIPT = /[²³¹⁰-₟ⁱ]/;

/**
 * True for a `text` op that needs superscript/subscript/radical layout. Such an
 * op is drawn as a GROUP of positioned runs and strokes rather than one
 * element, so it takes the same path as the diagram primitives.
 */
function isMathText(op: DrawOp): boolean {
  return op.op === "text" && hasMathNotation(op.text);
}


/** A copy of the op moved by (dx, dy) — start and end points alike. */
function shiftOp(op: DrawOp, dx: number, dy: number): DrawOp {
  if (!dx && !dy) return op;
  const out: DrawOp = { ...op, x: (op.x ?? 0) + dx, y: (op.y ?? 0) + dy };
  if (op.op === "arrow" || op.op === "line" || op.op === "curvearrow") {
    if (typeof op.x2 === "number") out.x2 = op.x2 + dx;
    if (typeof op.y2 === "number") out.y2 = op.y2 + dy;
  }
  if (op.points) out.points = op.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
  if (op.atoms) out.atoms = op.atoms.map((a) => ({ ...a, x: a.x + dx, y: a.y + dy }));
  if (op.items) out.items = op.items.map((a) => ({ ...a, x: a.x + dx, y: a.y + dy }));
  if (op.nodes) out.nodes = op.nodes.map((a) => (typeof a.x === "number" && typeof a.y === "number" ? { ...a, x: a.x + dx, y: a.y + dy } : a));
  return out;
}
