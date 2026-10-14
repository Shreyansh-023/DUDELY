"use client";

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getCommonBounds,
  getVisibleSceneBounds,
  newElementWith,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { DrawOp } from "../schema";
import { clamp, sleep } from "../utils";
import { opToSkeleton } from "./ops";
import { PRIMITIVES } from "./primitives";

/**
 * Plays draw ops onto a live Excalidraw scene with a "hand-drawn" feel:
 * text is typed out character by character, arrows grow from start to end,
 * shapes fade in. Everything is appended with CaptureUpdateAction.NEVER so
 * the student's undo stack is untouched.
 */
export class BoardPlayer {
  /** LLM-chosen id -> actual element id in the scene. */
  private idMap = new Map<string, string>();
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
   * Slide/paging: the model draws every turn in a PAGE-LOCAL frame (top-left ≈
   * 80,80). The player shifts each turn's content down by `pageShiftY` so turns
   * stack as "pages" on the infinite canvas and never pile up on each other. The
   * matching summary reports existing content in the same page-local frame.
   */
  private pageShiftY = 0;
  private static PAGE_TOP = 80;
  private static PAGE_GAP = 110;
  /**
   * Doubt "side canvas": while answering a doubt the player shifts that turn's
   * content to the RIGHT of everything else (pageShiftX) instead of below it, so
   * the quick side-note never disturbs the main lesson flow. Its elements are
   * tracked so `clearSide` can wipe just the doubt when the student moves on.
   */
  private pageShiftX = 0;
  private sideMode = false;
  private sideIds = new Set<string>();
  private static SIDE_GAP = 140;

  constructor(private api: ExcalidrawImperativeAPI) {}

  /** How far the current turn's page-local coordinates are shifted down the canvas. */
  get pageShift(): number {
    return this.pageShiftY;
  }

  /**
   * Begin a doubt answer: place this turn's content on a side canvas to the RIGHT
   * of everything drawn so far, and let transient pointing arrows linger longer (a
   * doubt is read more slowly than a teaching aside). Keeps the vertical position
   * so the side-note sits beside the current lesson page, not below it.
   */
  beginSide() {
    const els = this.all().filter((e) => !e.isDeleted && e.width >= 0 && e.height >= 0);
    const right = els.length ? Math.max(...els.map((e) => e.x + e.width)) : 1000;
    this.pageShiftX = Math.max(0, right + BoardPlayer.SIDE_GAP - BoardPlayer.PAGE_TOP);
    this.sideMode = true;
    this.ephemeralLingerMs = BoardPlayer.SIDE_LINGER_MS;
  }

  /** Wipe just the doubt's side canvas and return to the main lesson flow. */
  clearSide() {
    if (this.sideIds.size) this.deleteIds(new Set(this.sideIds));
    this.sideIds.clear();
    this.pageShiftX = 0;
    this.sideMode = false;
    this.ephemeralLingerMs = BoardPlayer.EPHEMERAL_LINGER_MS;
  }

  /** True while a doubt is being answered on the side canvas. */
  get inSideMode(): boolean {
    return this.sideMode;
  }

  /**
   * Start a new page for the next turn. Normally advances to a fresh band just
   * below everything drawn so far, so each turn gets its own clean page. When the
   * student has just drawn something (`stayOnPage`), we keep the current page so
   * the reply lands next to their work instead of jumping away.
   */
  advancePage(stayOnPage: boolean) {
    if (stayOnPage) return;
    const els = this.all().filter((e) => !e.isDeleted && e.width >= 0 && e.height >= 0);
    if (!els.length) {
      this.pageShiftY = 0;
      return;
    }
    const bottom = Math.max(...els.map((e) => e.y + e.height));
    this.pageShiftY = Math.max(0, bottom + BoardPlayer.PAGE_GAP - BoardPlayer.PAGE_TOP);
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

  private resolveId(llmId: string | null | undefined): string {
    const base = (llmId || "el").replace(/[^a-zA-Z0-9_-]/g, "_");
    const live = new Set(this.all().filter((e) => !e.isDeleted).map((e) => e.id));
    let candidate = base;
    let n = 2;
    while (live.has(candidate) || this.idMap.has(candidate)) candidate = `${base}_${n++}`;
    if (llmId) this.idMap.set(llmId, candidate);
    return candidate;
  }

  private deleteIds(ids: Set<string>) {
    const next = this.all().map((e) => {
      const group = (e.customData as { group?: string } | undefined)?.group;
      const hit =
        ids.has(e.id) ||
        (group != null && ids.has(group)) || // erase the whole primitive by its parent id
        ("containerId" in e && e.containerId != null && ids.has(e.containerId));
      return hit && !e.isDeleted ? newElementWith(e, { isDeleted: true }) : e;
    });
    this.commit(next);
  }

  /** Applies a beat's ops in order. Resolves when all animation is done or the signal aborts. */
  async applyBeat(ops: DrawOp[], turn: number, signal: AbortSignal): Promise<ExcalidrawElement[]> {
    this.currentTurn = turn;
    const created: ExcalidrawElement[] = [];
    for (const op of ops) {
      if (signal.aborted) break;
      try {
        const els = await this.applyOp(op, turn, signal);
        created.push(...els);
        // Remember side-canvas elements so a later clearSide() can wipe just the doubt.
        if (this.sideMode) for (const e of els) this.sideIds.add(e.id);
      } catch (err) {
        console.warn("[board] failed op", op, err);
      }
      await sleep(80, signal);
    }
    if (created.length) {
      // Jump to the new turn's work area the first time it draws, then just follow
      // along (only scroll if later beats in the turn spill off-screen).
      if (turn !== this.recenteredTurn) {
        this.recenteredTurn = turn;
        this.recenter();
      } else {
        this.ensureVisible(turn);
      }
    }
    return created;
  }

  private async applyOp(op: DrawOp, turn: number, signal: AbortSignal): Promise<ExcalidrawElement[]> {
    if (op.op === "clear") {
      this.cancelEphemeralFades();
      const next = this.all().map((e) => (e.isDeleted ? e : newElementWith(e, { isDeleted: true })));
      this.commit(next);
      this.idMap.clear();
      this.turnShift = { turn: 0, dx: 0, dy: 0 };
      this.pageShiftY = 0; // board wiped: the next content starts a fresh first page
      this.pageShiftX = 0;
      this.sideMode = false;
      this.sideIds.clear();
      this.ephemeralLingerMs = BoardPlayer.EPHEMERAL_LINGER_MS;
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

    const elementId = this.resolveId(op.id);
    const skeleton = opToSkeleton(shiftOp(op, carried.dx + this.pageShiftX, carried.dy + this.pageShiftY), turn, elementId);
    if (!skeleton) return [];

    const converted = convertToExcalidrawElements([skeleton], { regenerateIds: false });
    if (!converted.length) return [];

    // Shapes with labels come back as [container, boundText].
    let rest = converted.slice(1);
    let primary: ExcalidrawElement = converted[0];
    if (primary.type === "text") {
      // Keep free-standing text from landing on top of anything already drawn.
      const { dx, dy } = this.collisionPush(primary);
      if (dx || dy) primary = newElementWith(primary, { x: primary.x + dx, y: primary.y + dy });
    } else if (op.op === "rect" || op.op === "ellipse" || op.op === "diamond") {
      // Shapes dodge existing content too — and drag the rest of the turn with
      // them, so arrows drawn next still connect where the model expected.
      const { dx, dy } = this.collisionPush(primary);
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
    const { ops: children, bbox, label } = PRIMITIVES[op.op](op);
    // Dodge existing content as a single block (carried = shift from earlier ops
    // this turn). The combined shift is applied to the children, so it works for
    // every primitive — including ones positioned by `points` (polygon), not x/y.
    // We do NOT feed the group's own placement back into turnShift.
    const probe = {
      id: "__group__",
      x: bbox.x + carried.dx + this.pageShiftX,
      y: bbox.y + carried.dy + this.pageShiftY,
      width: bbox.w,
      height: bbox.h,
    } as unknown as ExcalidrawElement;
    const { dx, dy } = this.collisionPush(probe);
    const tx = carried.dx + dx + this.pageShiftX;
    const ty = carried.dy + dy + this.pageShiftY;
    const placed = tx || ty ? children.map((c) => shiftOp(c, tx, ty)) : children;

    const groupId = this.resolveId(op.id); // one stable id for the whole group
    const created: ExcalidrawElement[] = [];
    for (const child of placed) {
      if (signal.aborted) break;
      const base = opToSkeleton(child, turn, this.resolveId(child.id));
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

  /** Large penalty for a move that would push the element above or left of the board origin. */
  private boundsPenalty(el: ExcalidrawElement, dx: number, dy: number): number {
    return el.y + dy < 0 || el.x + dx < 0 ? 1e6 : 0;
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
  private collisionPush(el: ExcalidrawElement): { dx: number; dy: number } {
    const obstacles = this.all().filter(
      (e) =>
        !e.isDeleted &&
        e.id !== el.id &&
        !(e.customData as { temp?: boolean; highlight?: boolean } | undefined)?.temp &&
        !(e.customData as { highlight?: boolean } | undefined)?.highlight,
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
    let wUp = 1.0;
    let wDown = 1.15;
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
      const score = Math.abs(c.dx || c.dy) * c.w + this.boundsPenalty(el, c.dx, c.dy);
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

  /** Scroll/zoom so this turn's drawings are on screen, only if they are not already. */
  private ensureVisible(turn: number) {
    const mine = this.all().filter(
      (e) => !e.isDeleted && (e.customData as { tutor?: boolean; turn?: number } | undefined)?.turn === turn,
    );
    if (!mine.length) return;
    const [x1, y1, x2, y2] = getCommonBounds(mine);
    const [vx1, vy1, vx2, vy2] = getVisibleSceneBounds(this.api.getAppState());
    const inside = x1 >= vx1 && y1 >= vy1 && x2 <= vx2 && y2 <= vy2;
    if (inside) return;
    this.api.scrollToContent(mine, { fitToContent: true, animate: true, duration: 450 });
  }

  /**
   * Scroll/zoom to what Guru is drawing right now (or last drew). Backs the
   * "Jump to Guru" button, for when the student has panned or zoomed away.
   * Falls back to all tutor content if the current turn drew nothing.
   */
  recenter() {
    const mine = this.all().filter(
      (e) => !e.isDeleted && (e.customData as { turn?: number } | undefined)?.turn === this.currentTurn,
    );
    const target = mine.length
      ? mine
      : this.all().filter((e) => !e.isDeleted && (e.customData as { tutor?: boolean } | undefined)?.tutor);
    if (!target.length) return;
    this.api.scrollToContent(target, { fitToContent: true, animate: true, duration: 450 });
  }

  /** Marks everything as deleted (used by the "New topic" button). */
  clearAll() {
    this.cancelEphemeralFades();
    const next = this.all().map((e) => (e.isDeleted ? e : newElementWith(e, { isDeleted: true })));
    this.commit(next);
    this.idMap.clear();
    this.turnShift = { turn: 0, dx: 0, dy: 0 };
    this.pageShiftY = 0;
    this.pageShiftX = 0;
    this.sideMode = false;
    this.sideIds.clear();
    this.ephemeralLingerMs = BoardPlayer.EPHEMERAL_LINGER_MS;
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
