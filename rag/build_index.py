"""Build a textbook retrieval index the app reads, using NVIDIA Nemotron embeddings.

No local model and no Ollama: pages are extracted as plain text with PyMuPDF and the
chunks are embedded by the hosted Nemotron-3-Embed-1B NIM (input_type="passage").
The matching query-side embedding lives in src/lib/rag.ts (input_type="query").

Besides the vector index, it emits structure.json: every Example / Theorem / Exercise
(with its questions) keyed by chapter + ordinal, so a student's positional reference
("example 2 of chapter 1", "theorem 1.2", "exercise 1.1 q3", "page 45") resolves by exact
lookup in src/lib/rag.ts instead of semantic search, which cannot find a position.

Layout (see rag/common.py):
    rag/data/sources/<book>/<edition>/*.pdf          input PDFs
    rag/data/index/<book>/<edition>/                 meta.json + chunks.json + vectors.f32 + structure.json (output)

    python rag/build_index.py --book ncert-class-10-maths --edition english
    python rag/build_index.py --book ncert-class-10-maths --edition english hindi

Needs NVIDIA_API_KEY in the environment or in .env at the repo root.
vectors.f32 is little-endian float32, row-major [count x dim], L2-normalized; the app
mmaps it and takes a dot product against the (also normalized) query vector.
"""

import argparse
import array
import json
import math
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path

import httpx
import pymupdf

from common import INDEX, SOURCES, book_title

EMBED_URL = os.environ.get("NVIDIA_EMBED_URL", "https://integrate.api.nvidia.com/v1/embeddings")
EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "nvidia/nemotron-3-embed-1b")
BATCH = 32
TARGET_CHARS = 1100
HARD_CHARS = 1600

# Chapter titles per book (for nice passage labels). Unknown books fall back to "Chapter N".
TITLES = {
    "ncert-class-10-maths": {
        1: "Real Numbers", 2: "Polynomials", 3: "Pair of Linear Equations in Two Variables",
        4: "Quadratic Equations", 5: "Arithmetic Progressions", 6: "Triangles",
        7: "Coordinate Geometry", 8: "Introduction to Trigonometry",
        9: "Some Applications of Trigonometry", 10: "Circles", 11: "Areas Related to Circles",
        12: "Surface Areas and Volumes", 13: "Statistics", 14: "Probability",
    },
}


def api_key() -> str:
    key = os.environ.get("NVIDIA_API_KEY")
    if not key:
        env = Path(__file__).resolve().parent.parent / ".env"
        if env.exists():
            m = re.search(r"^\s*NVIDIA_API_KEY\s*=\s*(.+)\s*$", env.read_text(encoding="utf-8"), re.M)
            if m:
                key = m.group(1).strip().strip('"').strip("'")
    if not key:
        sys.exit("NVIDIA_API_KEY not set (environment or .env)")
    return key


def clean(t: str) -> str:
    t = t.replace("­", "")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def chunk_paras(paras: list[str]) -> list[str]:
    out: list[str] = []
    buf = ""
    for p in paras:
        p = p.strip()
        if not p:
            continue
        if len(p) > HARD_CHARS:
            if buf:
                out.append(buf)
                buf = ""
            for i in range(0, len(p), TARGET_CHARS):
                out.append(p[i : i + TARGET_CHARS])
            continue
        if len(buf) + len(p) + 1 <= TARGET_CHARS:
            buf = (buf + "\n" + p).strip()
        else:
            if buf:
                out.append(buf)
            buf = p
    if buf:
        out.append(buf)
    return out


# ---------------------------------------------------------------- printed pages

# The running header carries the book's printed page number: even pages "6 MATHEMATICS",
# odd pages "REAL NUMBERS 7" / "QUADRATIC EQUATIONS 45". We read a few, then map every
# pdf page to a printed page by a constant per-PDF offset (printed = pdf_index + offset).
_HDR_EVEN = re.compile(r"\b(\d{1,3})\s+MATHEMATICS\b")
_HDR_ODD = re.compile(r"\b[A-Z][A-Z]+(?:\s[A-Z]+)*\s+(\d{1,3})\b")


def printed_number(page_text: str) -> int | None:
    head = page_text[:120]
    m = _HDR_EVEN.search(head)
    if m:
        return int(m.group(1))
    m = _HDR_ODD.search(head)
    if m:
        return int(m.group(1))
    return None


def printed_offset(doc: "pymupdf.Document") -> int:
    """printed_page - (pdf_page_index + 1), taken as the mode over detectable pages."""
    offsets = []
    for i in range(doc.page_count):
        p = printed_number(clean(doc[i].get_text()))
        if p is not None:
            offsets.append(p - (i + 1))
    return Counter(offsets).most_common(1)[0][0] if offsets else 0


# ---------------------------------------------------------------- structure

# Example / Theorem / Exercise headings. These are the units a student references by
# position ("example 2", "theorem 1.2", "exercise 1.1 q3") — semantic search can't find
# a position, so we index them for deterministic lookup (see src/lib/rag.ts).
# Appendix PDFs use EXERCISE A1.1 etc.; chapter PDFs use EXERCISE 1.1.
_MAJOR = re.compile(r"(Example\s+\d+\s*:|Theorem\s+\d+\.\d+\s*:|EXERCISE\s+A?\d+\.\d+)")
_EX_NUM = re.compile(r"Example\s+(\d+)")
_TH_REF = re.compile(r"Theorem\s+(\d+\.\d+)")
_EXR_REF = re.compile(r"EXERCISE\s+(A?\d+\.\d+)")
_QNUM = re.compile(r"(?m)^\s*(\d{1,2})\.\s")
MAX_UNIT_CHARS = 1800
MAX_Q_CHARS = 700


def cap(s: str, n: int) -> str:
    s = s.strip()
    return s if len(s) <= n else s[:n].rstrip() + " …"


# Section headings "8.1 Introduction", "8.2 Trigonometric Ratios" at the start of a line.
# These give the chapter's teaching sequence; a section's opening prose is the book's hook
# / analogy for the topic (e.g. the Qutub Minar example that opens Trigonometry).
_SECTION = re.compile(r"(?m)^\s*(\d+)\.(\d+)\s+([A-Z][^\n]{1,58})")
MAX_INTRO_CHARS = 1000


def add_sections(struct: dict, ch: int | None, full: str, page_at) -> None:
    if ch is None:
        return
    majors = [m.start() for m in _MAJOR.finditer(full)]  # examples/theorems/exercises
    seen: dict[int, dict] = {}
    for m in _SECTION.finditer(full):
        if int(m.group(1)) != ch:
            continue
        minor = int(m.group(2))
        if minor in seen:
            continue  # first occurrence is the heading; later ones are cross-references
        title = re.sub(r"\s+", " ", m.group(3)).strip().rstrip(".")
        seen[minor] = {"ref": f"{ch}.{minor}", "title": title, "start": m.start(),
                       "pdfPage": page_at(m.start())[0], "printedPage": page_at(m.start())[1]}
    sections = [seen[k] for k in sorted(seen)]
    bounds = sorted([s["start"] for s in sections] + majors + [len(full)])
    out = []
    for s in sections:
        end = next((b for b in bounds if b > s["start"]), len(full))
        out.append({"ref": s["ref"], "title": s["title"],
                    "intro": cap(full[s["start"]:end], MAX_INTRO_CHARS),
                    "pdfPage": s["pdfPage"], "printedPage": s["printedPage"]})
    if out:
        struct["sections"][str(ch)] = out
        struct["outlines"][str(ch)] = " · ".join(f'{s["ref"]} {s["title"]}' for s in out)


def add_structure(struct: dict, ch: int | None, full: str, page_at) -> None:
    """Find Example/Theorem/Exercise units in one chapter's full text and record them.

    Appendix / answers PDFs (jemh1a1, jemh1an, …) have no chapter number in the
    filename (`ch is None`). Examples still match _MAJOR there — do not fall through
    to the Exercise branch just because ch is missing.
    """
    marks = list(_MAJOR.finditer(full))
    for i, m in enumerate(marks):
        start = m.start()
        end = marks[i + 1].start() if i + 1 < len(marks) else len(full)
        seg = full[start:end]
        pdf_page, printed = page_at(start)
        head = m.group(0)
        if head.startswith("Example"):
            # Examples are keyed by chapter; skip structural index when chapter is unknown
            # (appendix). Semantic chunks from the same PDF still cover that content.
            if ch is None:
                continue
            num_m = _EX_NUM.match(head)
            if not num_m:
                continue
            num = num_m.group(1)
            slot = struct["examples"].setdefault(str(ch), {})
            if num not in slot or len(seg) > len(slot[num]["text"]):
                slot[num] = {"text": cap(seg, MAX_UNIT_CHARS), "pdfPage": pdf_page, "printedPage": printed}
        elif head.startswith("Theorem"):
            th_m = _TH_REF.match(head)
            if not th_m:
                continue
            ref = th_m.group(1)
            if ref not in struct["theorems"] or len(seg) > len(struct["theorems"][ref]["text"]):
                struct["theorems"][ref] = {"text": cap(seg, MAX_UNIT_CHARS), "pdfPage": pdf_page, "printedPage": printed}
        elif head.startswith("EXERCISE"):
            ex_m = _EXR_REF.match(head)
            if not ex_m:
                continue
            ref = ex_m.group(1)
            questions: dict[str, dict] = {}
            qmarks = list(_QNUM.finditer(seg))
            for j, q in enumerate(qmarks):
                qs = q.start()
                qe = qmarks[j + 1].start() if j + 1 < len(qmarks) else len(seg)
                questions[q.group(1)] = {"text": cap(seg[qs:qe], MAX_Q_CHARS)}
            struct["exercises"][ref] = {
                "text": cap(seg, MAX_UNIT_CHARS), "pdfPage": pdf_page, "printedPage": printed, "questions": questions,
            }


def extract(book: str, edition: str) -> tuple[list[dict], dict]:
    titles = TITLES.get(book, {})
    src = SOURCES / book / edition
    pdfs = sorted(src.glob("*.pdf"))
    if not pdfs:
        sys.exit(f"no PDFs in {src}")
    chunks: list[dict] = []
    struct = {"examples": {}, "theorems": {}, "exercises": {}, "sections": {}, "outlines": {}}
    cid = 0
    for pdf in pdfs:
        if pdf.stat().st_size < 10000:  # skip truncated / 404-error files
            print(f"  skip {pdf.name} (too small)")
            continue
        m = re.search(r"(\d\d)(?:\D*)$", pdf.stem)
        ch = int(m.group(1)) if m else None
        title = titles.get(ch) if ch is not None else None
        label = f"Chapter {ch}: {title}" if title else (f"Chapter {ch}" if ch else pdf.stem)
        kind = "answers" if pdf.stem.endswith("an") else "chapter"
        doc = pymupdf.open(pdf)
        offset = printed_offset(doc)

        # Full chapter text with a char-offset -> (pdf page, printed page) map for structure.
        full = ""
        spans: list[tuple[int, int, int, int]] = []  # (start, end, pdf_page, printed_page)
        for pno in range(doc.page_count):
            txt = clean(doc[pno].get_text())
            printed = pno + 1 + offset
            s = len(full)
            full += txt + "\n"
            spans.append((s, len(full), pno + 1, printed))
            if len(txt) < 40:
                continue
            for c in chunk_paras(txt.split("\n\n")):
                c = c.strip()
                if len(c) < 40:
                    continue
                chunks.append(
                    {"id": cid, "stem": pdf.stem, "chapter": ch, "label": label,
                     "pages": [pno + 1, pno + 1], "printedPage": printed, "kind": kind, "text": c}
                )
                cid += 1

        def page_at(pos: int) -> tuple[int, int]:
            for s, e, pdf_page, printed in spans:
                if s <= pos < e:
                    return pdf_page, printed
            return spans[-1][2], spans[-1][3]

        add_structure(struct, ch, full, page_at)
        add_sections(struct, ch, full, page_at)
        print(f"  {pdf.name}: {label} — {doc.page_count} pages (printed offset {offset:+d})")
    return chunks, struct


def embed_passages(http: httpx.Client, key: str, texts: list[str]) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), BATCH):
        batch = texts[i : i + BATCH]
        r = http.post(
            EMBED_URL,
            headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
            json={"model": EMBED_MODEL, "input": batch, "input_type": "passage"},
        )
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:400]}")
        data = sorted(r.json()["data"], key=lambda d: d["index"])
        out.extend(d["embedding"] for d in data)
        print(f"\r  embedded {min(i + BATCH, len(texts))}/{len(texts)} passages", end="", flush=True)
    print()
    return out


def l2_normalize(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--book", required=True, help='textbook key, e.g. "ncert-class-10-maths"')
    p.add_argument("--edition", nargs="+", required=True, help="edition folder(s), e.g. english hindi")
    args = p.parse_args()

    key = api_key()
    http = httpx.Client(timeout=120)
    for edition in args.edition:
        print(f"\n{book_title(args.book)} [{edition}]")
        chunks, struct = extract(args.book, edition)
        if not chunks:
            print("  no chunks; skipping")
            continue
        started = time.perf_counter()
        vecs = embed_passages(http, key, [c["text"] for c in chunks])
        dim = len(vecs[0])
        flat = array.array("f")
        for v in vecs:
            flat.extend(l2_normalize(v))

        out_dir = INDEX / args.book / edition
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "chunks.json").write_text(json.dumps(chunks, ensure_ascii=False), encoding="utf-8")
        (out_dir / "vectors.f32").write_bytes(flat.tobytes())
        (out_dir / "structure.json").write_text(json.dumps(struct, ensure_ascii=False), encoding="utf-8")
        (out_dir / "meta.json").write_text(
            json.dumps({"book": args.book, "edition": edition, "embedModel": EMBED_MODEL,
                        "dim": dim, "count": len(chunks)}),
            encoding="utf-8",
        )
        n_ex = sum(len(v) for v in struct["examples"].values())
        n_sec = sum(len(v) for v in struct["sections"].values())
        mins = (time.perf_counter() - started) / 60
        print(f"  wrote {len(chunks)} chunks x {dim}d + structure "
              f"({n_ex} examples, {len(struct['theorems'])} theorems, {len(struct['exercises'])} exercises, "
              f"{n_sec} sections) to {out_dir} in {mins:.1f} min")


if __name__ == "__main__":
    main()
