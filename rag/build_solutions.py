"""Parse the NCERT solution PDFs into one JSON record per question/answer pair.

Unlike the textbook PDFs handled by build_index.py, these are Vedantu solution sheets:
already question-and-answer shaped, so a chunk can be a whole Q/A pair instead of a
fixed-size window. That keeps a question and its answer together in retrieval and lets
positional lookups ("exercise 8.2 q3") resolve exactly.

    rag/NCERT_Solutions/Class_<n>/<SUBJECT>/*.pdf    input (one PDF per chapter/exercise)
    rag/data/solutions/solutions.json                output (every Q/A pair, with metadata)

    python rag/build_solutions.py
    python rag/build_solutions.py --classes 9 10 --subjects MATHS

solutions.json is the source of truth and is inspectable/diffable on its own;
embed_solutions.py turns it into the vector index the app reads.

Four PDF generations are in the corpus and all four are handled (see QUESTION):
legacy "1." + "Ans:", newer "Question 1." + "Solution:", a colon variant
"Question 1:" + "Solution 1:", and letter labels "A." / "B." used in classes 1-2.

Text is extracted with sort=True. Without it the older MathType-rendered PDFs come out
as a column of 1-3 character fragments (Class 10 Maths went from 78% such lines to 11%).
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import pymupdf

from common import DATA, RAG_DIR

SOLUTIONS_SRC = RAG_DIR / "NCERT_Solutions"
OUT_DIR = DATA / "solutions"

SUBJECT_NAMES = {"MATHS": "Mathematics", "SCIENCE": "Science", "EVS": "EVS"}

# Vedantu page furniture: running heads, bare page numbers, watermark lines.
BOILERPLATE = re.compile(
    r"(?im)^\s*(?:www\.vedantu\.com.*"
    r"|Class\s+[IVX0-9]+\s+(?:Maths|Mathematics|Science|EVS).*"
    r"|\d{1,3})\s*$"
)

# Section/exercise headers. Covers the NCF textbook rubrics ("Figure it Out",
# "Let us Do") as well as plain exercise numbering, with an optional page anchor.
SECTION = re.compile(
    r"(?im)^\s*("
    r"(?:NCERT\s+)?(?:Intext\s+)?(?:Exercise|EXERCISE)\s*(?:NO\s*:)?\s*\d+(?:\.\d+)?"
    r"|(?:Think and Reflect|Intext Questions?|Figure it Out|Let us (?:Do|Think|Explore)"
    r"|Write|Discuss|Find Out|Activity\s*\d*)"
    r"(?:\s*\((?:NCERT\s+Textbook\s+)?Page\s*(?:No\.?)?\s*[\d\-,\s]+\))?"
    r")\s*$"
)

# Question label, in the four flavours the corpus uses. Groups: numbered-with-word,
# bare-numbered, lettered.
QUESTION = re.compile(
    r"(?m)^\s*(?:(?:Question|Q)\s*\.?\s*(\d{1,3})\s*[\.\):]"
    r"|(\d{1,3})\s*[\.\)]"
    r"|([A-Z])\s*[\.\)])\s+(?=\S)"
)

# "Ans:", "Answer:", "Solution:", "Solution 4:" ...
ANSWER = re.compile(r"(?im)^\s*(?:Ans(?:wer)?|Solution)\s*\d{0,3}\s*[:.]\s*")

# A sub-part label: "(i)", "ii)", "(a)". Multi-part questions put one of these before
# each sub-question and give every one its own "Ans:", so a naive split on the outer
# number leaves several Q/A pairs stuck inside one answer.
SUBPART = re.compile(
    r"(?m)^\s*\(?((?:i{1,3}|iv|vi{0,3}|ix|xi{0,2}|x)|[a-h])\)\s+(?=\S)",
    re.IGNORECASE,
)

PAGE_ANCHOR = re.compile(r"(?i)\(\s*(?:NCERT\s+Textbook\s+)?Page\s*(?:No\.?)?\s*(\d{1,3})")
EXERCISE_NO = re.compile(r"(?i)Exercise\s*(?:NO\s*:)?\s*(\d+(?:\.\d+)?)")
DEVANAGARI = re.compile(r"[ऀ-ॿ]")

# Symptoms of the old MathType pipeline, which positions every glyph absolutely and so
# loses sub/superscripts and fraction bars. These survive sort=True (which fixes line
# order but cannot rebuild 2-D layout), so they are what math_quality actually measures:
# "a 4" was a subscript, "1 5 9 / 3 3 3" was a row of fractions, "= -.2" was "= -2".
MATH_DAMAGE = (
    re.compile(r"\b[a-z]\s+\d\b"),                  # a_4 -> "a 4"
    re.compile(r"(?m)^\s*(?:\d+\s+){2,}\d+\s*$"),   # stacked fraction numerators
    re.compile(r"(?m)^\s*[+\-−=]\s*$"),        # operator stranded on its own line
    re.compile(r"[=<>]\s*[-−]?\s*\.\d"),       # "= -.2"
    re.compile(r"[-−]{2}"),
)


def clean(text: str) -> str:
    text = text.replace("​", "").replace("﻿", "").replace("­", "")
    text = BOILERPLATE.sub("", text)
    text = re.sub(r"[ \t ]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def math_quality(text: str) -> str:
    """How far this answer's maths survived extraction, as a retrieval hint.

    "clean"    - prose and inline maths read normally
    "degraded" - a symbol or two lost its position; the method is still followable
    "poor"     - several, so formulas should not be quoted back to a student verbatim

    Scored per Q/A pair, not per file: in the same chapter a word problem can be clean
    while the algebra beside it is mangled.
    """
    hits = sum(len(p.findall(text)) for p in MATH_DAMAGE)
    per_kline = hits / max(1, len(text) / 1000)
    if per_kline >= 4:
        return "poor"
    if hits:
        return "degraded"
    return "clean"


DOC_HEADER = re.compile(
    # The heading frequently wraps, so allow one newline inside the title; it is
    # collapsed to a space before use.
    r"(?i)chapter\s*[-–]?\s*(\d{1,2})\s*[-–:]?\s*"
    r"([A-Za-z][A-Za-z &,'–-]{3,60}(?:\n[A-Za-z][A-Za-z &,'–-]{2,40})?)"
)


def chapter_of(stem: str, full: str = "") -> tuple[int | None, str | None]:
    """Chapter number and title, preferring the PDF's own header over the filename.

    Some files are misnamed — "Statistics Exercise 13.1" actually holds Chapter 14
    Probability — so the heading printed inside the document wins where it exists.
    """
    doc = DOC_HEADER.search(full)
    if doc:
        return int(doc.group(1)), tidy_title(" ".join(doc.group(2).split()))
    m = re.search(r"(?i)chapter\s*(\d{1,2})", stem)
    if m:
        return int(m.group(1)), None
    m = EXERCISE_NO.search(stem)
    if m:
        return int(float(m.group(1))), None
    return None, None


def tidy_title(t: str) -> str:
    """Drop the stock phrases Vedantu wraps around a chapter name."""
    for _ in range(3):  # the phrases nest: "... Question Answer - Class 7 Science"
        before = t
        t = re.sub(r"(?i)^\s*(?:NCERT\s+)?(?:Solutions?|Question\s+Answers?)\s*"
                   r"(?:for|For)?\s*[-–:]?\s*", "", t)
        t = re.sub(r"(?i)\s*[-–:]?\s*(?:Question\s+Answers?|Solutions?)\s*$", "", t)
        t = re.sub(r"(?i)\bClass\s*\d*\s*(?:Maths|Mathematics|Science|EVS)?\s*$", "", t)
        t = t.strip(" -–_|.,:")
        if t == before:
            break
    return re.sub(r"\s{2,}", " ", t).strip(" -–_|.,:")


def chapter_title(stem: str, chapter: int | None) -> str:
    """Recover the human chapter name from the filename.

    Filenames look like "Class 7 Science Chapter 9 Life Processes In Animals" or
    "NCERT Solutions Class 8 Maths Chapter 2 The Baudhayana-Pythagoras Theorem".
    """
    t = stem
    t = re.sub(r"(?i)^\s*NCERT\s+Solutions?\s*(?:for|For)?\s*", "", t)
    t = re.sub(r"(?i)\bClass\s*\d+\b", "", t)
    # Only strip the series/subject label where it prefixes the title. "Science" also
    # occurs inside real chapter names ("The Ever-Evolving World of Science"), and
    # removing it there leaves the title dangling on a preposition.
    t = re.sub(r"(?i)^[\s\-–]*(?:Maths|Mathematics|Science|Social Science|EVS"
               r"|Our Wonderous World|Our Wondrous World|Curiosity|Ganita Manjari"
               r"|Ganita Prakash(?:\s+Part\s+\d+)?|Joyful|Maths Mela)\b", "", t)
    t = re.sub(r"(?i)\bIn Hindi\b", "", t)
    t = re.sub(r"(?i)\bchapter\s*\d{1,2}\b", "", t)
    # The label can also sit between "Class N" and "Chapter N", which the prefix rule
    # above cannot see until the chapter marker is gone.
    t = re.sub(r"(?i)^[\s\-–]*(?:Maths|Mathematics|Science|Social Science|EVS"
               r"|Our Wonderous World|Our Wondrous World|Curiosity|Ganita Manjari"
               r"|Ganita Prakash(?:\s+Part\s+\d+)?|Joyful|Maths Mela)\b", "", t)
    t = re.sub(r"(?i)\bexercise\s*\d+(?:\.\d+)?\b", "", t)
    t = re.sub(r"(?i)\(?\s*(?:free\s+)?pdf\s*\)?|\bvedantu\b|\(\s*\d{4}\s*[-–]\s*\d{2,4}\s*\)"
               r"|\b\d{4}\s*[-–]\s*\d{2}\b", "", t)
    t = re.sub(r"[_\-–]+", " ", t)
    t = tidy_title(t)
    return t or (f"Chapter {chapter}" if chapter else stem)


def split_subparts(question: str, answer: str) -> list[tuple[str, str, str | None]]:
    """Break "(i) ... Ans: ... (ii) ... Ans: ..." into one triple per sub-part.

    Returns (question, answer, subpart_label). A question with no sub-parts, or whose
    sub-parts do not each carry their own answer, comes back unchanged as a single
    triple so nothing is lost.
    """
    if not ANSWER.search(answer):
        return [(question, answer, None)]

    # The first sub-part's text sits in `question`; the rest follow inside `answer`.
    marks = list(SUBPART.finditer(answer))
    if not marks:
        return [(question, answer, None)]

    out: list[tuple[str, str, str | None]] = []
    lead = answer[: marks[0].start()].strip()
    first = SUBPART.match(question.strip())
    out.append((SUBPART.sub("", question, count=1).strip() if first else question,
                lead, first.group(1).lower() if first else None))

    # A trailing bare "Ans:" with nothing after it marks an answer that was a picture;
    # keep the record (has_image_answer covers it) but drop the dangling label.
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(answer)
        body = answer[m.end(): end]
        split = ANSWER.search(body)
        if not split:
            # No answer of its own: fold it back into the previous part rather than
            # emitting a question we cannot answer.
            q, a, lbl = out[-1]
            out[-1] = (q, (a + "\n" + answer[m.start(): end]).strip(), lbl)
            continue
        out.append((body[: split.start()].strip(), body[split.end():].strip(),
                    m.group(1).lower()))
    return [(q, a, l) for q, a, l in out if len(q) >= 10]


def split_sections(full: str) -> list[tuple[str, str]]:
    marks = [(m.start(), m.group(1).strip()) for m in SECTION.finditer(full)]
    if not marks or marks[0][0] > 0:
        marks.insert(0, (0, ""))
    out = []
    for i, (start, name) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(full)
        out.append((name, full[start:end]))
    return out


def parse_pdf(path: Path, cls: int, subject: str) -> list[dict]:
    doc = pymupdf.open(path)
    raw = "\n".join(page.get_text(sort=True) for page in doc)
    pages = [clean(page.get_text(sort=True)) for page in doc]
    doc.close()

    # Hindi editions come through with a broken font encoding (the glyphs map to
    # nothing readable), so there is nothing worth embedding.
    if len(DEVANAGARI.findall(raw)) > 200:
        return []

    full = "\n".join(pages)
    stem = path.stem
    chapter, doc_title = chapter_of(stem, full)
    # Both sources are unreliable in different ways: the filename can name the wrong
    # chapter, while the in-document heading is often clipped by a line wrap or by the
    # stock "Question Answer" prefix. Take the number from the document and the title
    # from whichever version is more complete.
    name_title = chapter_title(stem, chapter)
    title = doc_title or name_title
    if doc_title and name_title:
        a, b = doc_title.lower(), name_title.lower()
        if b.startswith(a) or (len(b) > len(a) and a in b):
            title = name_title
    file_ex = EXERCISE_NO.search(full) or EXERCISE_NO.search(stem)

    records = []
    for section, body in split_sections(full):
        hits = [(m.start(), m.group(1) or m.group(2) or m.group(3))
                for m in QUESTION.finditer(body)]
        for i, (start, label) in enumerate(hits):
            end = hits[i + 1][0] if i + 1 < len(hits) else len(body)
            segment = body[start:end].strip()
            split = ANSWER.search(segment)
            question = (segment[: split.start()] if split else segment).strip()
            answer = (segment[split.end():] if split else "").strip()

            # Strip the label itself off the question text; it is kept in `number`.
            question = QUESTION.sub("", question, count=1).strip()
            if len(question) < 10:
                continue
            # A question that is only punctuation and separators is what is left when
            # an all-maths question lost its glyphs; there is nothing to retrieve on.
            if len(re.sub(r"[^0-9A-Za-z]", "", question)) < 4:
                continue

            anchor = PAGE_ANCHOR.search(section) or PAGE_ANCHOR.search(segment)
            ex = EXERCISE_NO.search(section) or file_ex
            for q, a, part in split_subparts(question, answer):
                a = re.sub(r"(?im)^\s*(?:Ans(?:wer)?|Solution)\s*\d{0,3}\s*[:.]\s*$", "", a).strip()
                records.append({
                    "class": cls,
                    "subject": SUBJECT_NAMES.get(subject, subject),
                    "chapter": chapter,
                    "chapter_title": title,
                    "section": section or None,
                    "exercise": ex.group(1) if ex else None,
                    "number": label if part is None else f"{label}({part})",
                    "question": re.sub(r"\n{2,}", "\n", q),
                    "answer": re.sub(r"\n{2,}", "\n", a),
                    "has_image_answer": len(a) < 5,
                    "math_quality": math_quality(q + "\n" + a),
                    "textbook_page": int(anchor.group(1)) if anchor else None,
                    "source_pdf": str(path.relative_to(SOLUTIONS_SRC)).replace("\\", "/"),
                })
    return records


def dedupe(records: list[dict]) -> tuple[list[dict], int]:
    """Drop the same question appearing in both a chapter PDF and an exercise PDF.

    The fingerprint uses prose words only: in the degraded PDFs the same equation
    renders differently in each file, so including maths would miss real duplicates.
    Ties are broken towards the record whose maths survived better, then the longer
    answer.
    """
    rank = {"clean": 0, "degraded": 1, "poor": 2}
    best: dict[tuple, dict] = {}
    order: list[tuple] = []
    dropped = 0
    for r in records:
        words = [w for w in re.sub(r"[^a-z ]", " ", r["question"].lower()).split() if len(w) > 2]
        if len(words) < 4:
            # Too little prose to fingerprint — a question that was almost entirely
            # maths. Fall back to the digits, which is enough to pair "2, ,3, ,..."
            # in a chapter PDF with the same question in its exercise PDF.
            digits = re.sub(r"\D", "", r["question"])[:24]
            key = ((r["class"], r["subject"], r["chapter"], r["number"], digits)
                   if digits else ("~uniq", len(order)))
        else:
            # Deliberately not keyed on chapter: a few PDFs disagree with each other
            # about which chapter a question belongs to, and the prose is specific
            # enough on its own within one class and subject.
            key = (r["class"], r["subject"], " ".join(words[:12]))
        prev = best.get(key)
        if prev is None:
            best[key] = r
            order.append(key)
            continue
        dropped += 1
        better = (rank[r["math_quality"]], -len(r["answer"])) < (
            rank[prev["math_quality"]], -len(prev["answer"]))
        if better:
            best[key] = r
    return [best[k] for k in order], dropped


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--classes", type=int, nargs="*", help="only these classes (default: all)")
    ap.add_argument("--subjects", nargs="*", help="MATHS / SCIENCE / EVS (default: all)")
    ap.add_argument("--out", type=Path, default=OUT_DIR / "solutions.json")
    args = ap.parse_args()

    if not SOLUTIONS_SRC.exists():
        sys.exit(f"missing {SOLUTIONS_SRC}")

    pdfs = []
    for d in sorted(SOLUTIONS_SRC.glob("Class_*")):
        cls = int(d.name.split("_")[1])
        if args.classes and cls not in args.classes:
            continue
        for sub in sorted(p for p in d.iterdir() if p.is_dir()):
            if args.subjects and sub.name not in args.subjects:
                continue
            for pdf in sorted(sub.glob("*.pdf")):
                pdfs.append((pdf, cls, sub.name))
    if not pdfs:
        sys.exit("no PDFs matched")

    records: list[dict] = []
    skipped: list[str] = []
    for pdf, cls, subject in pdfs:
        try:
            got = parse_pdf(pdf, cls, subject)
        except Exception as exc:  # a single bad PDF should not stop the build
            print(f"  ERROR {pdf.name}: {exc}")
            skipped.append(f"{pdf.name}: {exc}")
            continue
        if not got:
            skipped.append(f"{pdf.name}: no parsable Q/A")
        records.extend(got)
        print(f"\r  parsed {len(records)} pairs from {pdf.name[:54]:<54}", end="", flush=True)
    print()

    records, dropped = dedupe(records)
    for i, r in enumerate(records):
        r["id"] = f"sol-{i:05d}"
        r["hash"] = hashlib.sha1(
            f"{r['class']}|{r['subject']}|{r['question'][:200]}".encode()).hexdigest()[:12]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(records, ensure_ascii=False, indent=1), encoding="utf-8")

    by_group: dict[tuple, int] = {}
    img = sum(1 for r in records if r["has_image_answer"])
    for r in records:
        k = (r["class"], r["subject"])
        by_group[k] = by_group.get(k, 0) + 1
    print(f"\n{'class':>7} {'subject':<12} {'pairs':>6}")
    for k in sorted(by_group):
        print(f"{k[0]:>7} {k[1]:<12} {by_group[k]:>6}")
    poor = sum(1 for r in records if r["math_quality"] == "poor")
    deg = sum(1 for r in records if r["math_quality"] == "degraded")
    print(f"\n{len(records)} Q/A pairs from {len(pdfs)} PDFs "
          f"({dropped} duplicates dropped)")
    print(f"  image-only answers: {img} ({img * 100 // max(1, len(records))}%)")
    print(f"  math_quality: poor {poor}, degraded {deg}, clean {len(records) - poor - deg}")
    if skipped:
        print(f"  skipped {len(skipped)} PDFs:")
        for s in skipped:
            print(f"    {s}")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
