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
   * When collision avoidance pushes a shape down, every later op in the same
   * turn is shifted by the same amount, so a diagram keeps its internal layout
   * (arrows drawn next still meet the shape where the model expected it).
   */
  private turnShift = { turn: 0, dy: 0 };

  constructor(private api: ExcalidrawImperativeAPI) {}

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
      const hit =
        ids.has(e.id) ||
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
      const next = this.all().map((e) => (e.isDeleted ? e : newElementWith(e, { isDeleted: true })));
      this.commit(next);
      this.idMap.clear();
      this.turnShift = { turn: 0, dy: 0 };
      return [];
    }
    if (op.op === "erase") {
      const ids = new Set<string>();
      for (const id of op.ids ?? []) ids.add(this.idMap.get(id) ?? id);
      this.deleteIds(ids);
      return [];
    }

    // Carry forward any downward shift collision avoidance made earlier in this turn.
    const shift = this.turnShift.turn === turn ? this.turnShift.dy : 0;
    const elementId = this.resolveId(op.id);
    const skeleton = opToSkeleton(shiftOpDown(op, shift), turn, elementId);
    if (!skeleton) return [];

    const converted = convertToExcalidrawElements([skeleton], { regenerateIds: false });
    if (!converted.length) return [];

    // Shapes with labels come back as [container, boundText].
    let rest = converted.slice(1);
    let primary: ExcalidrawElement = converted[0];
    if (primary.type === "text") {
      // Keep free-standing text from landing on top of anything already drawn.
      primary = this.avoidOverlap(primary as ExcalidrawTextElement);
    } else if (op.op === "rect" || op.op === "ellipse" || op.op === "diamond") {
      // Shapes dodge existing content too — and drag the rest of the turn with
      // them, so arrows drawn next still connect where the model expected.
      const dy = this.collisionShift(primary);
      if (dy > 0) {
        primary = newElementWith(primary, { y: primary.y + dy });
        rest = rest.map((e) => newElementWith(e, { y: e.y + dy }));
        this.turnShift = { turn, dy: shift + dy };
      }
    }
    // Highlights and arrows/lines keep their coordinates: highlights overlay
    // content on purpose, arrows deliberately touch the things they point at.

    if (primary.type === "text") {
      await this.typeText(primary as ExcalidrawTextElement, signal);
    } else if (primary.type === "arrow" || primary.type === "line") {
      await this.growLine(primary as ExcalidrawLinearElement, rest, signal);
    } else {
      await this.fadeIn(primary, rest, signal);
    }
    return [primary, ...rest];
  }

  /**
   * Collision avoidance: if this text's box overlaps anything already on the
   * board, push it straight down to just below the lowest thing it hits.
   */
  private avoidOverlap(el: ExcalidrawTextElement): ExcalidrawTextElement {
    const dy = this.collisionShift(el);
    return dy > 0 ? newElementWith(el, { y: el.y + dy }) : el;
  }

  /**
   * How far down (px) this element must move for its box to clear everything
   * already on the board; 0 when it is already clear. Models pick absolute
   * coordinates and often misjudge rendered sizes; this keeps the board
   * readable no matter what coordinates arrive. Arrows and lines are not
   * obstacles — they are thin, and labels/shapes legitimately sit on them.
   */
  private collisionShift(el: ExcalidrawElement): number {
    const gap = 14;
    const obstacles = this.all().filter(
      (e) =>
        !e.isDeleted &&
        e.id !== el.id &&
        e.type !== "arrow" &&
        e.type !== "line" &&
        e.width > 0 &&
        e.height > 0,
    );
    if (!obstacles.length) return 0;

    const x1 = el.x;
    const x2 = el.x + el.width;
    let y1 = el.y;
    let y2 = el.y + el.height;
    for (let iter = 0; iter < 24; iter++) {
      let lowestHit = -Infinity;
      for (const o of obstacles) {
        const ox1 = o.x;
        const oy1 = o.y;
        const ox2 = o.x + o.width;
        const oy2 = o.y + o.height;
        const hits = x1 < ox2 + gap && x2 > ox1 - gap && y1 < oy2 + gap && y2 > oy1 - gap;
        if (hits && oy2 > lowestHit) lowestHit = oy2;
      }
      if (lowestHit === -Infinity) break; // clear
      const dy = lowestHit + gap - y1;
      y1 += dy;
      y2 += dy;
    }
    return y1 - el.y;
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
    const next = this.all().map((e) => (e.isDeleted ? e : newElementWith(e, { isDeleted: true })));
    this.commit(next);
    this.idMap.clear();
    this.turnShift = { turn: 0, dy: 0 };
  }
}

/** A copy of the op moved down by dy (start and end points alike). */
function shiftOpDown(op: DrawOp, dy: number): DrawOp {
  if (!dy) return op;
  const out: DrawOp = { ...op, y: (op.y ?? 0) + dy };
  if ((op.op === "arrow" || op.op === "line") && typeof op.y2 === "number") out.y2 = op.y2 + dy;
  return out;
}
