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
import { isPermanentNote, opToSkeleton, type TutorMeta } from "./ops";
import {
  CLEARANCE,
  CONTENT_BOTTOM,
  CONTENT_TOP,
  FIT_MARGIN,
  MIN_TURN_ROOM,
  PAGE_H,
  PAGE_W,
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
import { PRIMITIVES, type Expanded } from "./primitives";

/** One page of the board, plus the bookkeeping the UI and the spill test need.
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
  /**
   * When collision avoidance moves a shape, every later op in the same turn is
   * shifted by the same vector, so a diagram keeps its internal layout (arrows
   * drawn next still meet the shape where the model expected it).
   */
  private turnShift = { turn: 0, dx: 0, dy: 0 };
  /** Pending fade-out timers for transient annotations, cancelled on clear. */
  private ephemeralTimers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * Paging: the board is a column of fixed PAGE_W x PAGE_H pages rather than one
   * endless surface. The model always draws in PAGE-LOCAL coordinates and the
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
  /** Re-anchors a beat at the top of a fresh page after a mid-turn spill. */
  private pageAnchorDy = 0;
  /** False while the student is reading a page other than the one being written. */
  private follow = true;
  private tween: number | null = null;
  /** The last viewport we wrote, so a student pan can be told from our own tween. */
  private lastWrote: { scrollX: number; scrollY: number; zoom: number } | null = null;
  private listeners = new Set<() => void>();
  private snapshot: PageSnapshot = { pages: [], activeIndex: -1, viewIndex: -1, follow: true };
  /** Primitives are expanded once per op: the fit test and the draw share this. */
  private expandCache = new WeakMap<object, Expanded>();

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
   * `newPage` forces a fresh page even when the current one has room. The staged
   * lesson uses it to give every plan step a page of its own: one page, one idea,
   * and — the reason it exists — a step's page state no longer depends on what
   * the previous step drew, so the next step can be generated while this one is
   * still being drawn without being told the wrong amount of room.
   */
  beginTeachTurn(opts?: { stayOnPage?: boolean; newPage?: boolean }) {
    this.doubtMode = false;
    this.plannedKind = "teach";
    this.pageAnchorDy = 0;
    this.ephemeralLingerMs = BoardPlayer.EPHEMERAL_LINGER_MS;
    if (opts?.stayOnPage && this.activeIndex >= 0) {
      this.planAt(this.pages[this.activeIndex]);
      this.emit();
      return;
    }
    if (opts?.newPage) {
      this.planAt(this.freshTeachSlot());
      this.emit();
      return;
    }
    const cur = this.teachIndex >= 0 ? this.pages[this.teachIndex] : undefined;
    this.planAt(
      cur && cur.kind === "teach" && CONTENT_BOTTOM - cur.bottom >= MIN_TURN_ROOM ? cur : this.freshTeachSlot(),
    );
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
    this.pageAnchorDy = 0;
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
    this.pageAnchorDy = 0;
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
   * The page `beginTeachTurn({ newPage: true })` would start on. The staged
   * lesson reads it to describe the page a step will own while that step is
   * still being generated. See `freshTeachSlot` for the reuse rule.
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
      };
      this.pages.push(p);
      this.plannedIndex = p.index;
    }
    this.activeIndex = p.index;
    if (p.kind === "teach") this.teachIndex = p.index;
    return p;
  }

  /** A fresh page of `kind` for a beat that spilled off the one it started on:
   *  teaching carries on down its column, a doubt along its row. */
  private appendPage(kind: PageKind): Page {
    this.plannedKind = kind;
    this.planAt(kind === "doubt" ? this.freshDoubtSlot() : { index: this.pages.length, row: this.lastRow() + 1, col: 0 });
    return this.ensurePage();
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
      // Post-collision committed bounds: where the content actually landed.
      const [, , , y2] = getCommonBounds(keep);
      p.bottom = Math.max(p.bottom, y2 - p.y);
      p.used = true;
    }
    p.rev++;
    this.emit();
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
    // The replay lays the beat out again from the model's own coordinates, so
    // neither the collision shift the abandoned attempt accumulated nor the page
    // it had spilled onto may carry over into it.
    this.turnShift = { turn: 0, dx: 0, dy: 0 };
    this.pageAnchorDy = 0;
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

  /** Re-derive every page's occupancy from what is actually left on the board. */
  private recomputePages() {
    const live = this.all().filter((e) => !e.isDeleted && isPermanentNote(e));
    for (const p of this.pages) {
      const mine = live.filter((e) => (e.customData as TutorMeta | undefined)?.page === p.index);
      if (!mine.length) {
        p.used = false;
        p.bottom = CONTENT_TOP;
      } else {
        const [, , , y2] = getCommonBounds(mine);
        p.used = true;
        p.bottom = Math.max(CONTENT_TOP, y2 - p.y);
      }
      p.rev++;
    }
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
    this.pageAnchorDy = 0;
    this.follow = true;
    this.recenteredTurn = 0; // so the next beat takes the re-frame branch
    this.ephemeralLingerMs = BoardPlayer.EPHEMERAL_LINGER_MS;
    this.expandCache = new WeakMap();
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
    const to = this.fitRect(this.pageSceneRect(index));
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

  /**
   * Applies a beat's ops in order. Resolves when all animation is done or the
   * signal aborts.
   *
   * Before any drawing: work out which page this beat belongs on and frame it.
   * A beat that would run off the bottom of a used page spills onto a fresh one
   * of the same kind, re-anchored at that page's top — so a long doubt simply
   * continues on the next page instead of folding back over its own content.
   */
  async applyBeat(ops: DrawOp[], turn: number, signal: AbortSignal): Promise<ExcalidrawElement[]> {
    this.currentTurn = turn;
    // erase/clear-only beats (and a beat with no draw ops at all) must not
    // allocate a page or move the camera, or an answer given in words alone
    // would leave a blank page behind.
    const drawing = ops.filter((o) => o.op !== "clear" && o.op !== "erase");
    if (drawing.length) {
      const page = this.ensurePage();
      const carried = this.turnShift.turn === turn ? this.turnShift : { dx: 0, dy: 0 };
      const box = this.measureBeat(drawing, carried);
      if (box && page.used) {
        // Collision avoidance will push this beat below what is already here;
        // model that push, or the beat spills one page later than it should.
        const push = Math.max(0, page.bottom + CLEARANCE - box.y1);
        if (box.y2 + push + FIT_MARGIN > CONTENT_BOTTOM) {
          this.appendPage(page.kind);
          this.turnShift = { turn, dx: 0, dy: 0 }; // stays page-local
          this.pageAnchorDy = CONTENT_TOP - box.y1;
        }
      }
      const target = this.pages[this.activeIndex];
      if (target && this.follow && (target.index !== this.framedIndex || turn !== this.recenteredTurn)) {
        this.recenteredTurn = turn;
        this.showPage(target.index, { animate: true }); // navigate, THEN draw
      }
    }
    const created: ExcalidrawElement[] = [];
    for (const op of ops) {
      if (signal.aborted) break;
      try {
        created.push(...(await this.applyOp(op, turn, signal)));
      } catch (err) {
        console.warn("[board] failed op", op, err);
      }
      await sleep(80, signal);
    }
    if (created.length) this.recordOnPage(this.activeIndex, turn, created);
    return created;
  }

  /** Expand a primitive once and reuse it: the fit test and the draw agree. */
  private expand(op: DrawOp): Expanded {
    let e = this.expandCache.get(op as object);
    if (!e) {
      e = PRIMITIVES[op.op](op);
      this.expandCache.set(op as object, e);
    }
    return e;
  }

  /**
   * The page-local box this beat WOULD occupy, before collision avoidance.
   * Built from real converted elements rather than measure.ts (which sizes a
   * stand-in font) or `e.y + e.height` (wrong for an arrow drawn upward).
   * Transient gestures are skipped: they fade, so they must not force a break.
   */
  private measureBeat(
    ops: DrawOp[],
    carried: { dx: number; dy: number },
  ): { x1: number; y1: number; x2: number; y2: number } | null {
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
      if (op.temp === true) continue;
      if (op.op === "arrow" && op.temp !== false) continue; // a bare arrow is a pointing gesture
      if (PRIMITIVES[op.op]) {
        const ex = this.expand(op);
        // The declared bbox carries padding the children do not report; the
        // children are exact where the bbox under-covers. Use both.
        add(ex.bbox.x, ex.bbox.y, ex.bbox.x + ex.bbox.w, ex.bbox.y + ex.bbox.h);
        for (const c of ex.ops) this.measureLow(c, add);
      } else {
        this.measureLow(op, add);
      }
    }
    if (!Number.isFinite(x1)) return null;
    return { x1: x1 + carried.dx, y1: y1 + carried.dy, x2: x2 + carried.dx, y2: y2 + carried.dy };
  }

  private measureLow(op: DrawOp, add: (x1: number, y1: number, x2: number, y2: number) => void) {
    const skel = opToSkeleton(op, 0, "__measure__");
    if (!skel) return;
    const els = convertToExcalidrawElements([skel], { regenerateIds: false });
    if (!els.length) return;
    const [x1, y1, x2, y2] = getCommonBounds(els);
    add(x1, y1, x2, y2);
  }

  private async applyOp(op: DrawOp, turn: number, signal: AbortSignal): Promise<ExcalidrawElement[]> {
    if (op.op === "clear") {
      this.cancelEphemeralFades();
      const next = this.all().map((e) => (e.isDeleted ? e : newElementWith(e, { isDeleted: true })));
      this.commit(next);
      this.idMap.clear();
      this.minted.clear();
      this.turnShift = { turn: 0, dx: 0, dy: 0 };
      this.resetPages(); // board wiped: back to a single blank first page
      return [];
    }
    if (op.op === "erase") {
      const ids = new Set<string>();
      for (const id of op.ids ?? []) ids.add(this.idMap.get(id) ?? id);
      this.deleteIds(ids);
      return [];
    }

    // Carry forward any shift collision avoidance made earlier in this turn.
    const carried = this.turnShift.turn === turn ? this.turnShift : { dx: 0, dy: 0 };
    // High-level primitives lay themselves out perfectly, then dodge as one unit.
    if (PRIMITIVES[op.op]) return this.applyGroup(op, carried, turn, signal);

    // A bare `arrow` op is a pointing gesture by default: it fades on its own
    // unless the model explicitly marks it permanent (temp:false). The model
    // routinely forgets temp:true on "look here" arrows, and a forgotten flag
    // used to leave a permanent arrow that piled up over the turns. Structural
    // arrows come from primitives (vector/axes/optics), not raw `arrow` ops,
    // so treating raw arrows as transient is safe. Marking it temp here also
    // keeps it from acting as a collision obstacle for later content.
    const ephemeral = op.op === "arrow" ? op.temp !== false : op.temp === true;
    if (ephemeral !== Boolean(op.temp)) op = { ...op, temp: ephemeral };

    const page = this.ensurePage();
    // The page origin is added HERE and never stored, so turnShift stays
    // page-local and its clamp keeps measuring the right quantity.
    const ox = page.x;
    const oy = page.y + this.pageAnchorDy;
    const elementId = this.resolveId(op.id);
    const skeleton = opToSkeleton(shiftOp(op, carried.dx + ox, carried.dy + oy), turn, elementId, page.index);
    if (!skeleton) return [];

    const converted = convertToExcalidrawElements([skeleton], { regenerateIds: false });
    if (!converted.length) return [];

    // Shapes with labels come back as [container, boundText].
    let rest = converted.slice(1);
    let primary: ExcalidrawElement = converted[0];
    if (primary.type === "text") {
      // Keep free-standing text from landing on top of anything already drawn.
      const { dx, dy } = this.collisionPush(primary, page.index);
      if (dx || dy) primary = newElementWith(primary, { x: primary.x + dx, y: primary.y + dy });
    } else if (op.op === "rect" || op.op === "ellipse" || op.op === "diamond") {
      // Shapes dodge existing content too — and drag the rest of the turn with
      // them, so arrows drawn next still connect where the model expected.
      const { dx, dy } = this.collisionPush(primary, page.index);
      if (dx || dy) {
        primary = newElementWith(primary, { x: primary.x + dx, y: primary.y + dy });
        rest = rest.map((e) => newElementWith(e, { x: e.x + dx, y: e.y + dy }));
        // A transient shape is about to vanish, so don't make the rest of the
        // turn inherit a shift caused by something that won't stay on the board.
        // Clamp upward/leftward accumulation so a shape escaping up can't march
        // the rest of the turn off the top/left of the work area.
        if (!op.temp)
          this.turnShift = {
            turn,
            dx: Math.max(carried.dx + dx, -120),
            dy: Math.max(carried.dy + dy, -120),
          };
      }
    }
    // Highlights and arrows/lines are not nudged when drawn — highlights overlay
    // content on purpose, arrows/lines deliberately touch what they point at — but
    // they still act as obstacles (above) so later text/shapes dodge them.

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
    return [primary, ...rest];
  }

  /**
   * Renders a high-level primitive (currently `numberline`) by lowering it to
   * low-level ops whose geometry is computed by code, so the structure can never
   * overlap itself. The whole group dodges pre-existing content as ONE unit
   * (reusing collisionPush on its bounding box); its children are pre-solved, so
   * they skip per-child collision — otherwise the axis line would shove its own
   * tick numbers around.
   */
  private async applyGroup(
    op: DrawOp,
    carried: { dx: number; dy: number },
    turn: number,
    signal: AbortSignal,
  ): Promise<ExcalidrawElement[]> {
    const page = this.ensurePage();
    const ox = page.x;
    const oy = page.y + this.pageAnchorDy;
    const { ops: children, bbox, label } = this.expand(op);
    // Dodge existing content as a single block (carried = shift from earlier ops
    // this turn). The combined shift is applied to the children, so it works for
    // every primitive — including ones positioned by `points` (polygon), not x/y.
    // We do NOT feed the group's own placement back into turnShift.
    const probe = {
      id: "__group__",
      x: bbox.x + carried.dx + ox,
      y: bbox.y + carried.dy + oy,
      width: bbox.w,
      height: bbox.h,
    } as unknown as ExcalidrawElement;
    const { dx, dy } = this.collisionPush(probe, page.index);
    const tx = carried.dx + dx + ox;
    const ty = carried.dy + dy + oy;
    const placed = tx || ty ? children.map((c) => shiftOp(c, tx, ty)) : children;

    const groupId = this.resolveId(op.id); // one stable id for the whole group
    const created: ExcalidrawElement[] = [];
    for (const child of placed) {
      if (signal.aborted) break;
      const base = opToSkeleton(child, turn, this.resolveId(child.id), page.index);
      if (!base) continue;
      // Tag children so the summary collapses the group and erase can target it.
      const skel = { ...base, customData: { ...(base.customData as object), group: groupId, groupLabel: label } };
      const converted = convertToExcalidrawElements([skel], { regenerateIds: false });
      if (!converted.length) continue;
      const rest = converted.slice(1);
      const primary = converted[0];
      if (primary.type === "text") {
        await this.typeText(primary as ExcalidrawTextElement, signal);
      } else if (primary.type === "arrow" || primary.type === "line") {
        // Short segments (ticks) snap in instantly; the long axis grows.
        if (Math.abs(primary.width) + Math.abs(primary.height) <= 24) this.placeInstant(primary, rest);
        else await this.growLine(primary as ExcalidrawLinearElement, rest, signal);
      } else {
        await this.fadeIn(primary, rest, signal);
      }
      created.push(primary, ...rest);
      await sleep(18, signal); // snappier than free-form ops — a group has many children
    }
    return created;
  }

  /** Commit an element (and any bound children) at full opacity, no animation. */
  private placeInstant(el: ExcalidrawElement, bound: ExcalidrawElement[]) {
    this.commit([...this.all(), el, ...bound]);
  }

  /** Near-zero-area segments (thin lines/arrows) get this much effective thickness. */
  private static MIN_THICK = 6;
  /** A single nudge never moves an element farther than this, so nothing is flung away. */
  private static MAX_TRAVEL = 400;

  /** Axis-aligned collision box for an obstacle; a thin segment is inflated into a band. */
  private obstacleBox(e: ExcalidrawElement): { x1: number; y1: number; x2: number; y2: number; thin: boolean } {
    const t = Math.max((e as { strokeWidth?: number }).strokeWidth ?? 2, BoardPlayer.MIN_THICK);
    let x1 = e.x;
    let y1 = e.y;
    let x2 = e.x + e.width;
    let y2 = e.y + e.height;
    let thin = false;
    if (e.width < t) {
      const c = e.x + e.width / 2;
      x1 = c - t / 2;
      x2 = c + t / 2;
      thin = true; // vertical line / tick
    }
    if (e.height < t) {
      const c = e.y + e.height / 2;
      y1 = c - t / 2;
      y2 = c + t / 2;
      thin = true; // horizontal line / number line / axis
    }
    return { x1, y1, x2, y2, thin };
  }

  private overlaps(el: ExcalidrawElement, b: { x1: number; y1: number; x2: number; y2: number }, gap: number): boolean {
    return el.x < b.x2 + gap && el.x + el.width > b.x1 - gap && el.y < b.y2 + gap && el.y + el.height > b.y1 - gap;
  }

  /** Large penalty for a move that would push the element off its own page. */
  private boundsPenalty(el: ExcalidrawElement, dx: number, dy: number, pageIndex: number): number {
    const r = this.pageSceneRect(pageIndex);
    const y1 = el.y + dy;
    const y2 = y1 + el.height;
    const x1 = el.x + dx;
    const x2 = x1 + el.width;
    return y1 < r.y + CONTENT_TOP - 40 || y2 > r.y + PAGE_H - 20 || x1 < r.x + 24 || x2 > r.x + PAGE_W - 24 ? 1e6 : 0;
  }

  /** The page an element belongs to — its tag, or its grid cell as a last resort. */
  private pageOf(e: ExcalidrawElement): number {
    const p = (e.customData as TutorMeta | undefined)?.page;
    if (typeof p === "number") return p;
    const { row, col } = cellAtScene(e.x + e.width / 2, e.y + e.height / 2);
    return this.pages.find((q) => q.row === row && q.col === col)?.index ?? 0;
  }

  /**
   * Collision avoidance. If this element's box overprints content already on the
   * board, return the smallest nudge that frees it as a {dx, dy} vector (0,0 when
   * it is already clear). It weighs four escapes — up, down, left, right — and
   * prefers moving UP into free space, then DOWN, then sideways, by the least
   * distance that clears everything. Models pick absolute coordinates and misjudge
   * rendered sizes; this keeps the board readable without reflowing anything.
   *
   * Structural lines AND arrows (number lines, axes, ticks, fraction bars) are
   * obstacles now, but a thin segment is only inflated to a ~6px band, so a tick
   * label is nudged just off the line and stays hugging it. Highlights (translucent
   * overlays) and transient 'temp' gestures are never obstacles.
   */
  private collisionPush(el: ExcalidrawElement, pageIndex: number): { dx: number; dy: number } {
    // Only this page's own content is an obstacle: pages are separate sheets,
    // so content on the previous one must never push this beat around.
    const obstacles = this.all().filter(
      (e) => !e.isDeleted && e.id !== el.id && isPermanentNote(e) && this.pageOf(e) === pageIndex,
    );
    if (!obstacles.length) return { dx: 0, dy: 0 };
    const boxes = obstacles.map((o) => this.obstacleBox(o));

    // Only move for a REAL overprint; a near-miss within the gap keeps the model's coords.
    const hit = boxes.filter((b) => this.overlaps(el, b, 0));
    if (!hit.length) return { dx: 0, dy: 0 };
    const onlyThin = hit.every((b) => b.thin);
    const gap = onlyThin ? 7 : 16; // keep tick labels snug to their line

    const up = this.clearDistance(el, boxes, gap, "y", -1);
    const down = this.clearDistance(el, boxes, gap, "y", 1);
    const left = this.clearDistance(el, boxes, gap, "x", -1);
    const right = this.clearDistance(el, boxes, gap, "x", 1);

    // Default: prefer up, then down, then sideways. For a thin-line overprint, keep
    // the label on whichever side of the line its centre already leans — so numbers
    // the model put above the line stay above and tick labels below stay below.
    // "Up" now means "toward the top of a fixed page", where there is far less
    // room to give, so the preference flips: dodge downward by default.
    let wUp = 1.15;
    let wDown = 1.0;
    if (onlyThin) {
      const bandCy = (hit[0].y1 + hit[0].y2) / 2;
      if (el.y + el.height / 2 >= bandCy) {
        wDown = 0.9;
        wUp = 1.2;
      } else {
        wUp = 0.9;
        wDown = 1.2;
      }
    }

    const cands: { dx: number; dy: number; w: number }[] = [];
    if (up !== null) cands.push({ dx: 0, dy: up, w: wUp });
    if (down !== null) cands.push({ dx: 0, dy: down, w: wDown });
    if (left !== null) cands.push({ dx: left, dy: 0, w: 1.5 });
    if (right !== null) cands.push({ dx: right, dy: 0, w: 1.5 });

    // Lowest score wins; the fixed up→down→left→right order makes ties deterministic.
    let best: { dx: number; dy: number } | null = null;
    let bestScore = Infinity;
    for (const c of cands) {
      const score = Math.abs(c.dx || c.dy) * c.w + this.boundsPenalty(el, c.dx, c.dy, pageIndex);
      if (score < bestScore - 0.01) {
        bestScore = score;
        best = { dx: c.dx, dy: c.dy };
      }
    }
    // Fully boxed in (no direction clears within MAX_TRAVEL): leave the model's
    // coordinates rather than fling the element across the board.
    return best ?? { dx: 0, dy: 0 };
  }

  /**
   * Signed distance the box must travel along one axis+direction to clear every
   * obstacle: axis "y"/"x", sign +1 (down/right) or -1 (up/left). Returns null if
   * it cannot clear within 32 iterations or MAX_TRAVEL. Iterates because clearing
   * one obstacle can slide the box into the next.
   */
  private clearDistance(
    el: ExcalidrawElement,
    boxes: { x1: number; y1: number; x2: number; y2: number }[],
    gap: number,
    axis: "x" | "y",
    sign: 1 | -1,
  ): number | null {
    let x1 = el.x;
    let y1 = el.y;
    let x2 = el.x + el.width;
    let y2 = el.y + el.height;
    for (let iter = 0; iter < 32; iter++) {
      let bestEdge = sign > 0 ? -Infinity : Infinity;
      for (const b of boxes) {
        const hits = x1 < b.x2 + gap && x2 > b.x1 - gap && y1 < b.y2 + gap && y2 > b.y1 - gap;
        if (!hits) continue;
        const edge = axis === "y" ? (sign > 0 ? b.y2 : b.y1) : sign > 0 ? b.x2 : b.x1;
        if (sign > 0 ? edge > bestEdge : edge < bestEdge) bestEdge = edge;
      }
      if (!Number.isFinite(bestEdge)) return axis === "y" ? y1 - el.y : x1 - el.x; // clear
      let step: number;
      if (axis === "y") step = sign > 0 ? bestEdge + gap - y1 : bestEdge - gap - y2;
      else step = sign > 0 ? bestEdge + gap - x1 : bestEdge - gap - x2;
      if (axis === "y") {
        y1 += step;
        y2 += step;
      } else {
        x1 += step;
        x2 += step;
      }
      if (Math.abs(axis === "y" ? y1 - el.y : x1 - el.x) > BoardPlayer.MAX_TRAVEL) return null;
    }
    return null; // did not converge
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
    this.turnShift = { turn: 0, dx: 0, dy: 0 };
    this.resetPages();
  }
}

/** A copy of the op moved by (dx, dy) — start and end points alike. */
function shiftOp(op: DrawOp, dx: number, dy: number): DrawOp {
  if (!dx && !dy) return op;
  const out: DrawOp = { ...op, x: (op.x ?? 0) + dx, y: (op.y ?? 0) + dy };
  if (op.op === "arrow" || op.op === "line") {
    if (typeof op.x2 === "number") out.x2 = op.x2 + dx;
    if (typeof op.y2 === "number") out.y2 = op.y2 + dy;
  }
  return out;
}
