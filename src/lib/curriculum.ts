/**
 * The curriculum the tutor covers: NCERT textbooks for classes 1-10, as
 * actually published by NCERT. The student picks a class first, then a
 * subject; that pair names exactly one textbook, which is the key the RAG
 * backend uses to narrow its vector search to that book's embeddings.
 *
 * Keep this the single source of truth for both the picker UI and the request
 * payload, so the id the UI shows and the id the backend looks up never drift.
 *
 * Subject availability per class (matches rag/build_corpus.py):
 *   - Classes 1-2: Maths only. NCERT publishes no separate Science/EVS
 *     textbook; the NCF folds that strand into language + maths.
 *   - Classes 3-5: Maths + EVS (the "Looking Around" series — EVS is the
 *     closest book available in place of Science at this stage).
 *   - Classes 6-10: Maths + Science.
 */

export const GRADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
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
 * How the "science" slot shows up for a given class — Science from Class 6,
 * EVS (Looking Around) for 3-5, nothing for 1-2. Lets the UI label the chip
 * correctly without the backend key ever changing: both EVS and Science live
 * under the same subject id "science".
 */
export function scienceSlot(grade: Grade): { label: string; emoji: string } | null {
  if (grade <= 2) return null;
  if (grade <= 5) return { label: "EVS", emoji: "🌱" };
  return { label: "Science", emoji: "🔬" };
}

/** Which subject ids are available for a given class. */
export function subjectsForGrade(grade: Grade): SubjectId[] {
  return scienceSlot(grade) ? ["maths", "science"] : ["maths"];
}

/** Label for a subject in the context of a specific class (Science vs EVS). */
export function subjectLabelFor(grade: Grade, id: SubjectId): string {
  if (id === "science") return scienceSlot(grade)?.label ?? "Science";
  return subjectLabel(id);
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
  return `NCERT Class ${grade} ${subjectLabelFor(grade, subject)}`;
}
