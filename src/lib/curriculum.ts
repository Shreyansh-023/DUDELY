/**
 * The curriculum the tutor covers: NCERT textbooks for Maths and Science,
 * classes 1 to 12. The student picks a class + subject in the chat UI; that
 * choice names exactly one textbook, which is the key the RAG backend uses to
 * narrow its vector search to that book's embeddings.
 *
 * Keep this the single source of truth for both the picker UI and the request
 * payload, so the id the UI shows and the id the backend looks up never drift.
 */

export const GRADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type Grade = (typeof GRADES)[number];

export const SUBJECTS = [
  { id: "maths", label: "Maths", emoji: "➗" },
  { id: "science", label: "Science", emoji: "🔬" },
] as const;
export type SubjectId = (typeof SUBJECTS)[number]["id"];

export function isGrade(n: unknown): n is Grade {
  return typeof n === "number" && (GRADES as readonly number[]).includes(n);
}

export function isSubject(s: unknown): s is SubjectId {
  return typeof s === "string" && SUBJECTS.some((x) => x.id === s);
}

export function subjectLabel(id: SubjectId): string {
  return SUBJECTS.find((s) => s.id === id)?.label ?? id;
}

/**
 * The textbook identifier the RAG backend filters on — one NCERT book per
 * (class, subject). The embedding store is expected to namespace/collection by
 * this exact string, e.g. "ncert-class-10-science". Returns null until the
 * student has chosen both, so callers can tell "not selected yet" apart from a
 * real selection.
 */
export function textbookKey(grade: Grade | null, subject: SubjectId | null): string | null {
  if (!isGrade(grade) || !isSubject(subject)) return null;
  return `ncert-class-${grade}-${subject}`;
}

/** Human-readable name of the chosen textbook, for labels and prompts. */
export function textbookLabel(grade: Grade | null, subject: SubjectId | null): string | null {
  if (!isGrade(grade) || !isSubject(subject)) return null;
  return `NCERT Class ${grade} ${subjectLabel(subject)}`;
}
