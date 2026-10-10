"use client";

import { getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, NonDeleted } from "@excalidraw/excalidraw/element/types";

type Meta = { tutor?: boolean; turn?: number; opId?: string } | undefined;

export function isTutorElement(e: ExcalidrawElement): boolean {
  return Boolean((e.customData as Meta)?.tutor);
}

const r = (n: number) => Math.round(n);

function describe(e: NonDeleted<ExcalidrawElement>, tag: string): string {
  const id = (e.customData as Meta)?.opId ?? e.id.slice(0, 6);
  const pos = `@(${r(e.x)},${r(e.y)}) ${r(e.width)}x${r(e.height)}`;
  if (e.type === "text") return `- [${id}] text ${pos} "${e.text.replace(/\n/g, " / ").slice(0, 80)}" (${tag})`;
  if (e.type === "freedraw") return `- [${id}] pen stroke ${pos} (${tag})`;
  if (e.type === "arrow" || e.type === "line") {
    const [dx, dy] = e.points[e.points.length - 1] ?? [0, 0];
    return `- [${id}] ${e.type} from (${r(e.x)},${r(e.y)}) to (${r(e.x + dx)},${r(e.y + dy)}) (${tag})`;
  }
  return `- [${id}] ${e.type} ${pos} (${tag})`;
}

/**
 * Builds the CANVAS block the LLM reads: a compact list of what is on the
 * board, which parts the student just added, and where free space begins.
 */
export function summarizeScene(
  elements: readonly NonDeleted<ExcalidrawElement>[],
  changedStudentIds: Set<string>,
): string {
  const visible = elements.filter((e) => !e.isDeleted);
  if (!visible.length) return "(board is empty)\nSuggested top-left for new content: (80, 80)";

  const tutor = visible.filter(isTutorElement);
  const student = visible.filter((e) => !isTutorElement(e));

  const lines: string[] = [];
  // Bound text of labelled shapes is noise; skip text elements that have a container.
  const tutorLines = tutor
    .filter((e) => !(e.type === "text" && e.containerId))
    .map((e) => describe(e, "tutor"));
  lines.push(...tutorLines.slice(-40));
  if (tutorLines.length > 40) lines.push(`- ... and ${tutorLines.length - 40} more tutor elements`);

  const studentLines = student.map((e) => describe(e, changedStudentIds.has(e.id) ? "student, NEW" : "student"));
  lines.push(...studentLines.slice(-15));
  if (studentLines.length > 15) lines.push(`- ... and ${studentLines.length - 15} more student strokes`);

  const [minX, , , maxY] = getCommonBounds(visible);
  const nextY = r(maxY + 80);
  const nextX = r(Math.max(80, minX));

  if (changedStudentIds.size) {
    const changed = student.filter((e) => changedStudentIds.has(e.id));
    const [sx1, sy1, sx2, sy2] = getCommonBounds(changed);
    lines.push(
      `Student just drew/changed ${changed.length} element(s) inside (${r(sx1)},${r(sy1)})-(${r(sx2)},${r(sy2)}).`,
    );
  }
  lines.push(`Suggested top-left for new content: (${nextX}, ${nextY})`);
  return lines.join("\n");
}
