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
    python rag/build_index.py --grades 1 2 3 4 5 6 7 8 9 --edition english

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
# Classes 1–9 use current NCF English editions (Joyful / Maths Mela / Ganita Prakash / Ganita Manjari).
TITLES = {
    "ncert-class-1-maths": {
        1: "Finding the Furry Cat!", 2: "What is Long? What is Round?", 3: "Mango Treat",
        4: "Making 10", 5: "How Many?", 6: "Vegetable Farm", 7: "Lina's Family",
        8: "Fun with Numbers", 9: "Utsav", 10: "How do I Spend my Day?",
        11: "How Many Times?", 12: "How Much Can We Spend?", 13: "So Many Toys",
    },
    "ncert-class-2-maths": {
        1: "A Day at the Beach", 2: "Shapes Around Us", 3: "Fun with Numbers",
        4: "Shadow Story (Togalu)", 5: "Playing with Lines", 6: "Decorations for Festival",
        7: "Rani's Gift", 8: "Grouping and Sharing", 9: "Which Season is it?",
        10: "Fun at the Fair", 11: "Data Handling",
    },
    "ncert-class-3-maths": {
        1: "What's in a Name?", 2: "Toy Joy", 3: "Double Century",
        4: "Vacation with My Nani Maa", 5: "Fun with Shapes", 6: "House of Hundreds–I",
        7: "Raksha Bandhan", 8: "Fair Share", 9: "House of Hundreds–II",
        10: "Fun at Class Party!", 11: "Filling and Lifting", 12: "Give and Take",
        13: "Time Goes On", 14: "The Surajkund Fair",
    },
    "ncert-class-4-maths": {
        1: "Shapes Around Us", 2: "Hide and Seek", 3: "Pattern Around Us",
        4: "Thousands Around Us", 5: "Sharing and Measuring", 6: "Measuring Length",
        7: "The Cleanest Village", 8: "Weigh it, Pour it", 9: "Equal Groups",
        10: "Elephants, Tigers, and Leopards", 11: "Fun with Symmetry",
        12: "Ticking Clocks and Turning Calendar", 13: "The Transport Museum", 14: "Data Handling",
    },
    "ncert-class-5-maths": {
        1: "We the Travellers—I", 2: "Fractions", 3: "Angles as Turns",
        4: "We the Travellers—II", 5: "Far and Near", 6: "The Dairy Farm",
        7: "Shapes and Patterns", 8: "Weight and Capacity", 9: "Coconut Farm",
        10: "Symmetrical Designs", 11: "Grandmother's Quilt", 12: "Racing Seconds",
        13: "Animal Jumps", 14: "Maps and Locations", 15: "Data Through Pictures",
    },
    "ncert-class-6-maths": {
        1: "Patterns in Mathematics", 2: "Lines and Angles", 3: "Number Play",
        4: "Data Handling and Presentation", 5: "Prime Time", 6: "Perimeter and Area",
        7: "Fractions", 8: "Playing with Constructions", 9: "Symmetry",
        10: "The Other Side of Zero",
    },
    "ncert-class-7-maths": {
        1: "Large Numbers Around Us", 2: "Arithmetic Expressions",
        3: "A Peek Beyond the Point", 4: "Expressions using Letter-Numbers",
        5: "Parallel and Intersecting Lines", 6: "Number Play",
        7: "A Tale of Three Intersecting Lines", 8: "Working with Fractions",
    },
    "ncert-class-8-maths": {
        1: "A Square and A Cube", 2: "Power Play", 3: "A Story of Numbers",
        4: "Quadrilaterals", 5: "Number Play", 6: "We Distribute, Yet Things Multiply",
        7: "Proportional Reasoning-1",
    },
    "ncert-class-9-maths": {
        1: "Orienting Yourself: The Use of Coordinates",
        2: "Introduction to Linear Polynomials",
        3: "The World of Numbers",
        4: "Exploring Algebraic Identities",
        5: "I'm Up and Down, and Round and Round",
        6: "Measuring Space: Perimeter and Area",
        7: "The Mathematics of Maybe: Introduction to Probability",
        8: "Predicting What Comes Next: Exploring Sequences and Progressions",
    },
    # ---- Science. Classes 3-5 are EVS ("Looking Around"), 6-8 "Curiosity", 9-10 "Science".
    "ncert-class-6-science": {
        1: "The Wonderful World of Science", 2: "Diversity in the Living World",
        3: "Mindful Eating: A Path to a Healthy Body", 4: "Exploring Magnets",
        5: "Measurement of Length and Motion", 6: "Materials Around Us",
        7: "Temperature and its Measurement", 8: "A Journey through States of Water",
        9: "Methods of Separation in Everyday Life", 10: "Living Creatures: Exploring their Characteristics",
        11: "Nature's Treasures", 12: "Beyond Earth",
    },
    "ncert-class-7-science": {
        1: "The Ever-Evolving World of Science", 2: "Exploring Substances: Acidic, Basic and Neutral",
        3: "Electricity: Circuits and their Components", 4: "The World of Metals and Non-metals",
        5: "Changes Around Us: Physical and Chemical", 6: "Adolescent Health and Well-being",
        7: "Heat Transfer in Nature", 8: "Measurement of Time and Motion",
        9: "Life Processes in Animals", 10: "Life Processes in Plants",
        11: "Light: Shadows and Reflections", 12: "Earth, Moon and the Sun",
    },
    "ncert-class-8-science": {
        1: "Exploring the Investigative World of Science",
        2: "The Invisible Living World: Beyond Our Naked Eye",
        3: "Health: The Ultimate Treasure",
        4: "Electricity: Magnetic and Heating Effects",
        5: "Exploring Forces", 6: "Pressure, Winds, Storms, and Cyclones",
        7: "Particulate Nature of Matter",
        8: "Nature of Matter: Elements, Compounds, and Mixtures",
        9: "The Amazing World of Solutes, Solvents, and Solutions",
        10: "Light: Mirrors and Lenses", 11: "Keeping Time with the Skies",
        12: "How Nature Works in Harmony",
        13: "Our Home: Earth, a Unique Life Sustaining Planet",
    },
    # Class 9 is the rewritten "Exploration" book (2025), not the old Science textbook.
    "ncert-class-9-science": {
        1: "Exploration: Entering the World of Secondary Science",
        2: "Cell: The Building Block of Life", 3: "Tissues in Action",
        4: "Describing Motion Around Us", 5: "Exploring Mixtures and their Separation",
        6: "How Forces Affect Motion", 7: "Work, Energy, and Simple Machines",
        8: "Journey Inside the Atom", 9: "Atomic Foundations of Matter",
        10: "Sound Waves: Characteristics and Applications",
        11: "Reproduction: How Life Continues",
        12: "Patterns in Life: Diversity and Classification",
        13: "Earth as a System: Energy, Matter, and Life",
    },
    "ncert-class-10-science": {
        1: "Chemical Reactions and Equations", 2: "Acids, Bases and Salts",
        3: "Metals and Non-metals", 4: "Carbon and its Compounds",
        5: "Life Processes", 6: "Control and Coordination",
        7: "How do Organisms Reproduce?", 8: "Heredity",
        9: "Light - Reflection and Refraction", 10: "The Human Eye and the Colourful World",
        11: "Electricity", 12: "Magnetic Effects of Electric Current",
        13: "Our Environment",
    },
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


def printed_offset_votes(doc: "pymupdf.Document") -> tuple[int, int]:
    """(offset, how many pages agree on it), offset = printed_page - (pdf_index + 1).

    The vote count is what tells a real offset from one or two stray matches on a
    picture-heavy chapter — see the caller in extract().
    """
    offsets = []
    for i in range(doc.page_count):
        p = printed_number(clean(doc[i].get_text()))
        if p is not None:
            offsets.append(p - (i + 1))
    if not offsets:
        return 0, 0
    offset, votes = Counter(offsets).most_common(1)[0]
    return offset, votes


def printed_offset(doc: "pymupdf.Document") -> int:
    """printed_page - (pdf_page_index + 1), taken as the mode over detectable pages."""
    return printed_offset_votes(doc)[0]


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
# A chapter offset is trusted only when at least this many pages agree on it;
# below that it is one or two stray matches, and the chapter chain wins.
MIN_OFFSET_VOTES = 3
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


def title_from_pdf(doc: "pymupdf.Document", ch: int | None) -> str | None:
    """Chapter title read off page 1: the largest-font text, minus the chapter number.

    NCERT rewrites books (Maths Mela, Curiosity, Exploration ...) and renames every
    chapter when it does, so a hardcoded TITLES entry goes stale silently. This reads
    the title from the PDF itself, and is used whenever TITLES has no entry.
    Returns None when page 1 has no clear title cluster (then the label is "Chapter N").
    """
    try:
        spans: list[tuple[float, str]] = []
        for block in doc[0].get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                for sp in line.get("spans", []):
                    t = sp["text"].strip()
                    if t:
                        spans.append((round(sp["size"], 1), t))
        if not spans:
            return None
        top = max(s for s, _ in spans)
        # The chapter number is often the single largest glyph; ignore pure numbers,
        # and keep every fragment within 2pt of the biggest remaining text.
        named = [(s, t) for s, t in spans if not re.fullmatch(r"\d{1,3}", t)]
        if not named:
            return None
        top = max(s for s, _ in named)
        parts = [t for s, t in named if s >= top - 2]
        title = re.sub(r"\s+", " ", " ".join(parts)).strip(" :-—·")
        # Drop a leading "Chapter N" / "N" the title block sometimes repeats.
        title = re.sub(r"^(?:Chapter\s*\d{0,3}\s*[-—:·]?\s*)", "", title, flags=re.I).strip()
        if ch is not None:
            title = re.sub(rf"^{ch}\s*[-—:·.]?\s*", "", title).strip()
        # A title is a few words, not a paragraph of body text.
        if not (3 <= len(title) <= 70) or len(title.split()) > 10:
            return None
        return title
    except Exception:
        return None


def extract(book: str, edition: str) -> tuple[list[dict], dict]:
    titles = TITLES.get(book, {})
    src = SOURCES / book / edition
    pdfs = sorted(src.glob("*.pdf"))
    if not pdfs:
        sys.exit(f"no PDFs in {src}")
    chunks: list[dict] = []
    struct = {"examples": {}, "theorems": {}, "exercises": {}, "sections": {}, "outlines": {}}
    cid = 0
    expected_offset = 0  # running printed-page total, for chapters with no readable header
    for pdf in pdfs:
        if pdf.stat().st_size < 10000:  # skip truncated / 404-error files
            print(f"  skip {pdf.name} (too small)")
            continue
        m = re.search(r"(\d\d)(?:\D*)$", pdf.stem)
        ch = int(m.group(1)) if m else None
        kind = "answers" if pdf.stem.endswith("an") else "chapter"
        doc = pymupdf.open(pdf)
        # Prefer the curated title; fall back to reading it off the PDF (new editions).
        title = titles.get(ch) if ch is not None else None
        if not title and kind == "chapter":
            title = title_from_pdf(doc, ch)
        label = f"Chapter {ch}: {title}" if title else (f"Chapter {ch}" if ch else pdf.stem)
        # NCERT paginates a book's chapters consecutively, so the offset of each chapter
        # is the previous one's offset plus its page count. That chain is a far stronger
        # signal than the running head on a picture-heavy page: some chapters have no
        # readable header at all (offset 0, i.e. "this chapter starts at printed page 1")
        # and others yield a nonsense offset from one or two stray matches (Class 7 Maths
        # ch1 read -23; Class 5 Maths ch5 read +4 where the chain says +46). Trust the
        # detected value only when enough pages agree on it; otherwise follow the chain.
        offset, votes = printed_offset_votes(doc)
        # A negative offset is impossible — a chapter cannot start before printed page 1.
        # It means the numbers being read aren't textbook pages: these files often have
        # an answer key appended with its own numbering (Class 7 Maths ch1 is 23 chapter
        # pages plus an answer sheet numbered from 1, which 7 pages "agree" is -23).
        # Reject it however well supported, falling back to the chain, or to 0 for the
        # first chapter, where there is no chain yet.
        if offset < 0:
            print(f"  {pdf.name}: detected printed offset {offset:+d} ({votes} vote(s)) is "
                  f"negative; using {expected_offset:+d}")
            offset = expected_offset
        elif expected_offset and offset != expected_offset:
            if votes < MIN_OFFSET_VOTES:
                print(f"  {pdf.name}: detected printed offset {offset:+d} ({votes} vote(s)) "
                      f"rejected; using chained offset {expected_offset:+d}")
                offset = expected_offset
            else:
                # Well supported and plausible. The chain only holds when page_count is
                # the chapter's own length; these PDFs append answer keys, so a confident
                # detected offset is the better value (verified against the printed book).
                print(f"  {pdf.name}: printed offset {offset:+d} ({votes} pages agree) "
                      f"differs from chained {expected_offset:+d}; keeping detected")
        # Where the next chapter should start, if its own header is unreadable too.
        expected_offset = offset + doc.page_count

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


def resolve_books(args: argparse.Namespace) -> list[str]:
    books: list[str] = list(args.book or [])
    if args.grades:
        books.extend(f"ncert-class-{g}-maths" for g in args.grades)
    # de-dupe, keep order
    seen: set[str] = set()
    out: list[str] = []
    for b in books:
        if b not in seen:
            seen.add(b)
            out.append(b)
    if not out:
        sys.exit("pass --book and/or --grades")
    return out


def build_one(http: httpx.Client, key: str, book: str, edition: str) -> None:
    print(f"\n{book_title(book)} [{edition}]")
    chunks, struct = extract(book, edition)
    if not chunks:
        print("  no chunks; skipping")
        return
    started = time.perf_counter()
    vecs = embed_passages(http, key, [c["text"] for c in chunks])
    dim = len(vecs[0])
    flat = array.array("f")
    for v in vecs:
        flat.extend(l2_normalize(v))

    out_dir = INDEX / book / edition
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "chunks.json").write_text(json.dumps(chunks, ensure_ascii=False), encoding="utf-8")
    (out_dir / "vectors.f32").write_bytes(flat.tobytes())
    (out_dir / "structure.json").write_text(json.dumps(struct, ensure_ascii=False), encoding="utf-8")
    (out_dir / "meta.json").write_text(
        json.dumps({"book": book, "edition": edition, "embedModel": EMBED_MODEL,
                    "dim": dim, "count": len(chunks)}),
        encoding="utf-8",
    )
    n_ex = sum(len(v) for v in struct["examples"].values())
    n_sec = sum(len(v) for v in struct["sections"].values())
    mins = (time.perf_counter() - started) / 60
    print(f"  wrote {len(chunks)} chunks x {dim}d + structure "
          f"({n_ex} examples, {len(struct['theorems'])} theorems, {len(struct['exercises'])} exercises, "
          f"{n_sec} sections) to {out_dir} in {mins:.1f} min")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--book", action="append", default=[], help='textbook key, e.g. "ncert-class-10-maths" (repeatable)')
    p.add_argument("--grades", nargs="+", type=int, help="shorthand: build ncert-class-N-maths for each N")
    p.add_argument("--edition", nargs="+", required=True, help="edition folder(s), e.g. english hindi")
    args = p.parse_args()

    key = api_key()
    http = httpx.Client(timeout=120)
    for book in resolve_books(args):
        for edition in args.edition:
            build_one(http, key, book, edition)


if __name__ == "__main__":
    main()
