"use client";

import { getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, NonDeleted } from "@excalidraw/excalidraw/element/types";
import { isPermanentNote } from "./ops";
import {
  CLEARANCE,
  CONTENT_BOTTOM,
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
      fixed?: true;
    }
  | undefined;

export function isTutorElement(e: ExcalidrawElement): boolean {
  return Boolean((e.customData as Meta)?.tutor);
}

/** True bounds. `e.y + e.height` is wrong for a line or arrow drawn up or left. */
const boxOf = (e: NonDeleted<ExcalidrawElement>) => getCommonBounds([e]);

/**
 * One line for one element. No coordinates: the model never places anything,
 * so a position would only tempt it to. What it needs is the id (to point at
 * or erase the element) and what the element says.
 */
function describe(e: NonDeleted<ExcalidrawElement>, tag: string): string {
  const id = (e.customData as Meta)?.opId ?? e.id.slice(0, 6);
  if (e.type === "text") return `- [${id}] text "${e.text.replace(/\n/g, " / ").slice(0, 80)}" (${tag})`;
  if (e.type === "freedraw") return `- [${id}] pen stroke (${tag})`;
  if (e.type === "arrow" || e.type === "line") return `- [${id}] ${e.type} (${tag})`;
  return `- [${id}] ${e.type} (${tag})`;
}

/**
 * A figure's summary line from the label its children carry. A polygon's
 * label names its vertices ("polygon ABC"), from which the model can name any
 * part: `at:"A"`, `at:"BC"`, `from:"A", to:"mid BC"`.
 */
function describeGroup(id: string, label: string): string {
  const m = /^polygon ([A-Za-z0-9]+)$/.exec(label);
  if (m && m[1].length >= 3) {
    const v = [...m[1]];
    const sides = v.map((a, i) => `${a}${v[(i + 1) % v.length]}`);
    return `- [${id}] polygon with vertices ${v.join(", ")} and sides ${sides.join(", ")} (tutor; annotate it by name with at/of)`;
  }
  return `- [${id}] ${label} (tutor)`;
}

/**
 * Builds the CANVAS block the LLM reads: which page it is writing on, what is
 * already on THAT page (by id and content, never by position), which parts the
 * student just added, and how much room is left before the page is full.
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
    const meta = e.customData as Meta;
    const g = meta?.group;
    if (g) {
      if (seenGroups.has(g)) continue;
      seenGroups.add(g);
      tutorLines.push(describeGroup(g, meta?.groupLabel ?? "figure"));
      continue;
    }
    tutorLines.push(describe(e, meta?.fixed ? "tutor, heading" : "tutor"));
  }
  lines.push(...tutorLines.slice(-40));
  if (tutorLines.length > 40) lines.push(`- ... and ${tutorLines.length - 40} more tutor elements`);

  const studentLines = student.map((e) => describe(e, changedStudentIds.has(e.id) ? "student, NEW" : "student"));
  lines.push(...studentLines.slice(-15));
  if (studentLines.length > 15) lines.push(`- ... and ${studentLines.length - 15} more student strokes`);

  if (changedStudentIds.size) {
    const changed = student.filter((e) => changedStudentIds.has(e.id));
    lines.push(`Student just drew/changed ${changed.length} element(s) on this page; your reply is placed beside their work.`);
  }

  // How much of the page is left. The board places the next content itself.
  const [, , , maxY] = getCommonBounds(visible);
  const rawNextY = maxY - frame.y + CLEARANCE;
  const remaining = Math.max(0, CONTENT_BOTTOM - Math.max(CONTENT_TOP, rawNextY));
  if (remaining < PAGE_FULL_ROOM) {
    lines.push(...PAGE_FULL_LINES);
  } else {
    lines.push(roomLine(remaining));
    if (remaining < LOW_ROOM) lines.push(lowRoomLine(remaining));
  }
  return lines.join("\n");
}
