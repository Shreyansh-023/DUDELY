"use client";

import { getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, NonDeleted } from "@excalidraw/excalidraw/element/types";
import { isPermanentNote } from "./ops";
import {
  CLEARANCE,
  CONTENT_BOTTOM,
  CONTENT_LEFT,
  CONTENT_RIGHT,
  CONTENT_TOP,
  LOW_ROOM,
  PAGE_FULL_LINES,
  PAGE_FULL_ROOM,
  blankPageCanvas,
  lowRoomLine,
  pageHeaderLine,
  pageRect,
  roomLine,
  type PageFrame,
} from "./page";

type Meta =
  | {
      tutor?: boolean;
      turn?: number;
      opId?: string;
      temp?: boolean;
      group?: string;
      groupLabel?: string;
      page?: number;
    }
  | undefined;

export function isTutorElement(e: ExcalidrawElement): boolean {
  return Boolean((e.customData as Meta)?.tutor);
}

const r = (n: number) => Math.round(n);

/** True bounds. `e.y + e.height` is wrong for a line or arrow drawn up or left. */
const boxOf = (e: NonDeleted<ExcalidrawElement>) => getCommonBounds([e]);

function describe(e: NonDeleted<ExcalidrawElement>, tag: string, frame: PageFrame): string {
  const id = (e.customData as Meta)?.opId ?? e.id.slice(0, 6);
  const ex = e.x - frame.x;
  const ey = e.y - frame.y;
  const pos = `@(${r(ex)},${r(ey)}) ${r(e.width)}x${r(e.height)}`;
  if (e.type === "text") return `- [${id}] text ${pos} "${e.text.replace(/\n/g, " / ").slice(0, 80)}" (${tag})`;
  if (e.type === "freedraw") return `- [${id}] pen stroke ${pos} (${tag})`;
  if (e.type === "arrow" || e.type === "line") {
    const [ldx, ldy] = e.points[e.points.length - 1] ?? [0, 0];
    return `- [${id}] ${e.type} from (${r(ex)},${r(ey)}) to (${r(ex + ldx)},${r(ey + ldy)}) (${tag})`;
  }
  return `- [${id}] ${e.type} ${pos} (${tag})`;
}

/**
 * Builds the CANVAS block the LLM reads: which page it is writing on, what is
 * already on THAT page (in the page-local frame the model draws in), which
 * parts the student just added, where free space begins and how much room is
 * left before the page is full.
 *
 * Everything is reported relative to the page's own origin, so the model always
 * works in top-left ≈ (80,80) coordinates and never sees another page.
 */
export function summarizeScene(
  elements: readonly NonDeleted<ExcalidrawElement>[],
  changedStudentIds: Set<string>,
  frame: PageFrame = { ...pageRect(0), row: 0, col: 0, index: 0, count: 1, kind: "teach" },
): string {
  // A tagged element names its own page; untagged content (a student stroke, or
  // anything drawn before pages existed) falls back to overlapping the rect.
  const onPage = (e: NonDeleted<ExcalidrawElement>) => {
    const p = (e.customData as Meta)?.page;
    if (p != null) return p === frame.index;
    const [x1, y1, x2, y2] = boxOf(e);
    return (
      y2 >= frame.y - 40 && y1 <= frame.y + frame.h + 40 && x2 >= frame.x - 40 && x1 <= frame.x + frame.w + 40
    );
  };
  const visible = elements.filter((e) => !e.isDeleted && isPermanentNote(e) && onPage(e));
  if (!visible.length) return blankPageCanvas(frame.index, frame.count, frame.kind);

  const tutor = visible.filter(isTutorElement);
  const student = visible.filter((e) => !isTutorElement(e));

  const lines: string[] = [pageHeaderLine(frame)];
  // Bound text of labelled shapes is noise; skip text elements that have a container.
  // Children of a high-level primitive (a numberline) collapse to ONE line keyed
  // by their shared group id, so the model sees the whole structure as a single
  // placed unit and never tries to redraw its ticks or plan around 25 children.
  const seenGroups = new Set<string>();
  const tutorLines: string[] = [];
  for (const e of tutor) {
    if (e.type === "text" && e.containerId) continue;
    const g = (e.customData as Meta)?.group;
    if (g) {
      if (seenGroups.has(g)) continue;
      seenGroups.add(g);
      const label = (e.customData as Meta)?.groupLabel ?? "numberline";
      // A group's size matters: the model cannot judge the room left on the page
      // if a 350px-tall axes reports itself as a point.
      const kids = tutor.filter((c) => (c.customData as Meta)?.group === g);
      const [gx1, gy1, gx2, gy2] = getCommonBounds(kids);
      tutorLines.push(
        `- [${g}] ${label} @(${r(gx1 - frame.x)},${r(gy1 - frame.y)}) ${r(gx2 - gx1)}x${r(gy2 - gy1)} (tutor)`,
      );
      continue;
    }
    tutorLines.push(describe(e, "tutor", frame));
  }
  lines.push(...tutorLines.slice(-40));
  if (tutorLines.length > 40) lines.push(`- ... and ${tutorLines.length - 40} more tutor elements`);

  const studentLines = student.map((e) =>
    describe(e, changedStudentIds.has(e.id) ? "student, NEW" : "student", frame),
  );
  lines.push(...studentLines.slice(-15));
  if (studentLines.length > 15) lines.push(`- ... and ${studentLines.length - 15} more student strokes`);

  if (changedStudentIds.size) {
    const changed = student.filter((e) => changedStudentIds.has(e.id));
    const [sx1, sy1, sx2, sy2] = getCommonBounds(changed);
    lines.push(
      `Student just drew/changed ${changed.length} element(s) inside (${r(sx1 - frame.x)},${r(sy1 - frame.y)})-(${r(sx2 - frame.x)},${r(sy2 - frame.y)}).`,
    );
  }

  // Where to carry on, and how much of the page is left. The suggestion is
  // clamped into the content box: on a fixed page there is no "just keep going
  // downward" any more.
  const [minX, , , maxY] = getCommonBounds(visible);
  const rawNextY = maxY - frame.y + CLEARANCE;
  const remaining = Math.max(0, CONTENT_BOTTOM - Math.max(CONTENT_TOP, rawNextY));
  if (remaining < PAGE_FULL_ROOM) {
    lines.push(...PAGE_FULL_LINES);
  } else {
    const nextY = Math.min(Math.max(CONTENT_TOP, rawNextY), CONTENT_BOTTOM);
    const nextX = Math.min(Math.max(CONTENT_LEFT, minX - frame.x), CONTENT_RIGHT - 200);
    lines.push(`Suggested top-left for new content: (${r(nextX)}, ${r(nextY)})`);
    lines.push(roomLine(remaining));
    if (remaining < LOW_ROOM) lines.push(lowRoomLine(remaining));
  }
  return lines.join("\n");
}
