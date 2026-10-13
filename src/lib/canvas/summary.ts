"use client";

import { getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, NonDeleted } from "@excalidraw/excalidraw/element/types";

type Meta = { tutor?: boolean; turn?: number; opId?: string; temp?: boolean; group?: string; groupLabel?: string } | undefined;

export function isTutorElement(e: ExcalidrawElement): boolean {
  return Boolean((e.customData as Meta)?.tutor);
}

/** Transient pointing gestures are about to fade — they are not part of the notes. */
function isTransient(e: ExcalidrawElement): boolean {
  return Boolean((e.customData as Meta)?.temp);
}

const r = (n: number) => Math.round(n);

function describe(e: NonDeleted<ExcalidrawElement>, tag: string, dy: number): string {
  const id = (e.customData as Meta)?.opId ?? e.id.slice(0, 6);
  const ey = e.y - dy;
  const pos = `@(${r(e.x)},${r(ey)}) ${r(e.width)}x${r(e.height)}`;
  if (e.type === "text") return `- [${id}] text ${pos} "${e.text.replace(/\n/g, " / ").slice(0, 80)}" (${tag})`;
  if (e.type === "freedraw") return `- [${id}] pen stroke ${pos} (${tag})`;
  if (e.type === "arrow" || e.type === "line") {
    const [ldx, ldy] = e.points[e.points.length - 1] ?? [0, 0];
    return `- [${id}] ${e.type} from (${r(e.x)},${r(ey)}) to (${r(e.x + ldx)},${r(ey + ldy)}) (${tag})`;
  }
  return `- [${id}] ${e.type} ${pos} (${tag})`;
}

/**
 * Builds the CANVAS block the LLM reads: what is on the CURRENT PAGE (in the
 * page-local frame the model draws in), which parts the student just added, and
 * where free space begins. `pageShift` is how far down the canvas this turn's
 * page sits; everything is reported minus that shift, so the model always works
 * in top-left ≈ (80,80) coordinates and never sees earlier pages.
 */
export function summarizeScene(
  elements: readonly NonDeleted<ExcalidrawElement>[],
  changedStudentIds: Set<string>,
  pageShift = 0,
): string {
  // Only the current page: drop transient gestures and anything whose top sits
  // above this page (i.e. on an earlier page / previous turn).
  const onPage = (e: NonDeleted<ExcalidrawElement>) => e.y - pageShift >= -40;
  const visible = elements.filter((e) => !e.isDeleted && !isTransient(e) && onPage(e));
  if (!visible.length) return "(this page is blank — draw new content starting at the top-left)\nSuggested top-left for new content: (80, 80)";

  const tutor = visible.filter(isTutorElement);
  const student = visible.filter((e) => !isTutorElement(e));

  const lines: string[] = [];
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
      tutorLines.push(`- [${g}] ${label} @(${r(e.x)},${r(e.y - pageShift)}) (tutor)`);
      continue;
    }
    tutorLines.push(describe(e, "tutor", pageShift));
  }
  lines.push(...tutorLines.slice(-40));
  if (tutorLines.length > 40) lines.push(`- ... and ${tutorLines.length - 40} more tutor elements`);

  const studentLines = student.map((e) => describe(e, changedStudentIds.has(e.id) ? "student, NEW" : "student", pageShift));
  lines.push(...studentLines.slice(-15));
  if (studentLines.length > 15) lines.push(`- ... and ${studentLines.length - 15} more student strokes`);

  const [minX, , , maxY] = getCommonBounds(visible);
  const nextY = r(maxY - pageShift + 80);
  const nextX = r(Math.max(80, minX));

  if (changedStudentIds.size) {
    const changed = student.filter((e) => changedStudentIds.has(e.id));
    const [sx1, sy1, sx2, sy2] = getCommonBounds(changed);
    lines.push(
      `Student just drew/changed ${changed.length} element(s) inside (${r(sx1)},${r(sy1 - pageShift)})-(${r(sx2)},${r(sy2 - pageShift)}).`,
    );
  }
  lines.push(`Suggested top-left for new content: (${nextX}, ${nextY})`);
  return lines.join("\n");
}
