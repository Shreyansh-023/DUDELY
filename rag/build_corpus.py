"""One-shot NCERT corpus builder: download -> extract -> embed -> index -> delete PDFs.

Does end to end, per book, what `download_ncert_maths.py` + `build_index.py` do in two
manual steps, for every class 1-10 x {maths, science} the NCERT site actually publishes:

    download chapter PDFs  ->  rag/data/sources/<book>/<edition>/
    extract text + structure, embed with the hosted Nemotron NIM
    write index            ->  rag/data/index/<book>/<edition>/
    delete that book's PDFs (so the copyrighted sources don't linger on disk)

The PDFs are deleted per book as soon as that book's index is written, so peak disk
stays at one book (~30 MB) instead of the whole corpus, and a crash halfway through
never leaves the whole set behind.

    python rag/build_corpus.py                       # everything (classes 1-10, both subjects)
    python rag/build_corpus.py --subject science     # one subject
    python rag/build_corpus.py --grades 9 10         # one or more classes
    python rag/build_corpus.py --keep-pdfs           # don't delete the sources
    python rag/build_corpus.py --dry-run             # list what would be built, download nothing

Needs NVIDIA_API_KEY (environment or .env at the repo root) — the same hosted
nvidia/nemotron-3-embed-1b NIM the rest of the pipeline uses. Nothing runs locally.

Resumable: a book whose index already exists is skipped unless --force. Chapter PDFs
already on disk are not re-downloaded.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Reuse the real pipeline rather than reimplementing it: extraction, chunking,
# structure parsing, embedding and the on-disk index format all live in build_index.py,
# so the index this writes is byte-for-byte the kind the app already reads.
import build_index as bi
import httpx
from common import INDEX, SOURCES, book_title

BASE = "https://ncert.nic.in/textbook/pdf"

# Chapter-file stem per (subject, class), verified against ncert.nic.in: files are
# {stem}{NN}.pdf. Codes are [class-letter][e=english][subject][1]:
#
#   maths    1-2 Joyful Mathematics · 3-5 Maths Mela · 6-8 Ganita Prakash · 9-10 Mathematics
#   science  3-5 Looking Around (EVS, "ev") · 6-8 Curiosity ("cu") · 9-10 Science ("sc")
#
# Classes 1-2 have no science/EVS textbook at all in the NCF scheme (the strand is
# folded into the language and maths books), so the corpus simply has no such book —
# see SKIPPED below, which explains it instead of silently missing.
STEMS: dict[str, dict[int, str]] = {
    "maths": {
        1: "aejm1", 2: "bejm1", 3: "cemm1", 4: "demm1", 5: "eemm1",
        6: "fegp1", 7: "gegp1", 8: "hegp1", 9: "iemh1", 10: "jemh1",
    },
    "science": {
        3: "ceev1", 4: "deev1", 5: "eeev1",
        6: "fecu1", 7: "gecu1", 8: "hecu1", 9: "iesc1", 10: "jesc1",
    },
}

SKIPPED = {
    ("science", 1): "NCERT publishes no separate Science/EVS book for Class 1 (NCF folds it into language + maths)",
    ("science", 2): "NCERT publishes no separate Science/EVS book for Class 2 (NCF folds it into language + maths)",
}

GRADES = list(range(1, 11))
SUBJECTS = ["maths", "science"]

MAX_CHAPTER = 20  # soft cap; probing stops after a run of misses
MIN_PDF_BYTES = 10_000  # smaller than this is a 404 page or a truncated file
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def book_key(subject: str, grade: int) -> str:
    """The key the app uses — must match src/lib/curriculum.ts textbookKey()."""
    return f"ncert-class-{grade}-{subject}"


# ---------------------------------------------------------------- download


def download(url: str, dest: Path, retries: int = 4) -> bool:
    """Fetch one chapter PDF. False = not published (404 / too small), not an error."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > MIN_PDF_BYTES:
        print(f"    keep {dest.name} ({dest.stat().st_size:,} bytes)")
        return True
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/pdf,*/*"})
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            last_err = e
        except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError) as e:
            last_err = e
        time.sleep(1.5 * (attempt + 1))  # NCERT drops bare / repeated connections
    else:
        raise DownloadFailed(f"{url}: {type(last_err).__name__}: {last_err}")
    if len(data) < MIN_PDF_BYTES:
        return False
    dest.write_bytes(data)
    print(f"    got  {dest.name} ({len(data):,} bytes)")
    return True


class DownloadFailed(RuntimeError):
    """The network failed (not a 404) while fetching a book, so it can't be built now."""


def download_book(subject: str, grade: int) -> int:
    """Download every published chapter of one book. Returns the chapter count.

    Raises DownloadFailed if the network drops; build_book turns that into a failed
    row so the remaining books still run. A long unattended pass over 18 books will
    meet a transient DNS/connection failure sooner or later, and losing 17 good books
    to one blip (as an uncaught URLError once did) is not acceptable.
    """
    stem = STEMS[subject][grade]
    out = SOURCES / book_key(subject, grade) / "english"
    # A rebuild over PDFs already on disk needs no network at all. Without this the
    # end-of-book probe still asks NCERT for the two chapters after the last one, so a
    # purely local --force run could (and did) die on a DNS failure.
    cached = sorted(p for p in out.glob(f"{stem}*.pdf") if p.stat().st_size > MIN_PDF_BYTES)
    if cached and (out / f"{stem}{len(cached):02d}.pdf").exists():
        print(f"    {len(cached)} chapter PDFs already cached; skipping download")
        return len(cached)
    count = 0
    misses = 0
    for n in range(1, MAX_CHAPTER + 1):
        code = f"{stem}{n:02d}"
        if download(f"{BASE}/{code}.pdf", out / f"{code}.pdf"):
            count += 1
            misses = 0
        else:
            misses += 1
            # Chapter numbering is contiguous; two misses in a row means the end
            # of the book (or, with nothing found yet, a wrong stem).
            if misses >= 2:
                break
    return count


# ---------------------------------------------------------------- science text quirks

# Science books are typeset differently from maths, and two differences break the
# maths-tuned extraction in build_index.py. Both are patched in (see patch_header_rules).
#
# 1. Running header. Maths pages read "6 MATHEMATICS" / "REAL NUMBERS 7" (ALL CAPS),
#    which is what build_index._HDR_EVEN/_HDR_ODD match. Science pages read
#    "Science\n2" and "Chemical Reactions and Equations\n3" — mixed case, and the
#    number comes *after* the title on even pages. Unpatched, printed_number()
#    returns None for every science page, printed_offset() falls back to 0, and every
#    printedPage in the index is wrong by the front-matter offset.
#
# 2. Layered text. Science headings are drawn several times for a shadow/outline
#    effect, so get_text() yields "Activity 1.1" five times in a row and section
#    headings arrive truncated ("1.2 TYPES OF CHEMIC"). Deduping consecutive repeats
#    keeps those from becoming five near-identical chunks competing in retrieval.

import re

# The title half tolerates anything a running head actually contains - em dashes,
# pipes, digits - because these books use, variously (\n = line break):
#   "Science \n 2"                                     Class 10 Science, even pages
#   "Chemical Reactions and Equations \n 3"            Class 10 Science, odd pages
#   "Chapter 5 - Exploring Forces \n 63"               Class 8 Curiosity
#   "Exploration|Grade 9 \n 74"                        Class 9 Exploration
#   "64 \n Curiosity - Textbook of Science for Grade 8"  number first
# Anchored to one line of title plus a bare number alone on its own line, so ordinary
# body text that happens to start with a capital cannot match.
# A running head is always the first one or two non-blank lines of a page, and is either
# "<number>\n<title>" or "<title>\n<number>". Rather than one dense regex over the whole
# head (which kept matching stray table numbers deeper in the page), look only at the
# first two non-blank lines and decide which is the number and which is the title.
#
# Real forms this must read, across every current NCF book:
#   "Science" / "2"                                   Class 10 Science, even pages
#   "Chemical Reactions and Equations" / "3"          Class 10 Science, odd pages
#   "Chapter 5 - Exploring Forces" / "63"             Class 8 Curiosity  (digit in title)
#   "Exploration|Grade 9" / "74"                      Class 9 Exploration (digit in title)
#   "191" / "Predicting What Comes Next: ..."         Class 9 Maths, number first
#   "Ganita Manjari |Grade 9| Part I" / "94"          Class 9 Maths banner
_PAGE_NUM = re.compile(r"^\d{1,3}$")
# A title line: starts with a letter, is mostly letters, and is not a sentence of prose.
_TITLE_LINE = re.compile(r"^[A-Za-z][^\n]{2,70}$")


def _looks_like_title(line: str) -> bool:
    """A running-head title, not body prose and not a bare number."""
    if not _TITLE_LINE.match(line):
        return False
    # Body prose ends in sentence punctuation or runs long; a head does neither.
    if line.rstrip().endswith((".", ",", ";", ":", "?", "!")) and len(line.split()) > 6:
        return False
    # Mostly letters/spaces — rejects rows of numbers and formula fragments.
    letters = sum(c.isalpha() or c.isspace() for c in line)
    return letters / max(len(line), 1) >= 0.6


def printed_number_any(page_text: str) -> int | None:
    """Printed page number from a mixed-case running head.

    Falls back to build_index's original ALL-CAPS rules (legacy Class 10 Maths), so
    nothing regresses for the one book those rules were written for.
    """
    lines = [ln.strip() for ln in page_text.split("\n")]
    lines = [ln for ln in lines[:6] if ln][:2]  # first two non-blank lines
    if len(lines) == 2:
        a, b = lines
        if _PAGE_NUM.match(a) and _looks_like_title(b):
            return int(a)
        if _PAGE_NUM.match(b) and _looks_like_title(a):
            return int(b)
    return _orig_printed_number(page_text)


def dedupe_lines(text: str) -> str:
    """Collapse consecutive identical lines (layered/shadowed headings drawn N times)."""
    out: list[str] = []
    for line in text.split("\n"):
        s = line.strip()
        if s and out and out[-1].strip() == s:
            continue
        out.append(line)
    return "\n".join(out)


_orig_printed_number = bi.printed_number  # keep the original to fall back to
_orig_clean = bi.clean


def patch_header_rules() -> None:
    """Point build_index at the mixed-case header reader and the line deduper.

    build_index's page-number rules were written for the legacy ALL-CAPS Class 10 Maths
    header; every current NCF book (Science *and* Maths) uses a mixed-case running head
    instead. Rather than fork its 300 lines of extraction we swap the two functions
    whose assumptions don't hold (see the notes above).

    Nothing regresses for the legacy book: printed_number_any() tries the new patterns
    first and defers to build_index's original rules when they don't match, and the
    deduper only drops *consecutive* duplicate lines, which prose does not contain.
    """
    bi.printed_number = printed_number_any
    bi.clean = lambda t: dedupe_lines(_orig_clean(t))


def unpatch() -> None:
    bi.printed_number = _orig_printed_number
    bi.clean = _orig_clean


# ---------------------------------------------------------------- build one book


def index_dir(subject: str, grade: int) -> Path:
    return INDEX / book_key(subject, grade) / "english"


def already_built(subject: str, grade: int) -> bool:
    d = index_dir(subject, grade)
    return (d / "meta.json").exists() and (d / "vectors.f32").exists()


def build_book(
    http: httpx.Client, key: str, subject: str, grade: int, *, keep_pdfs: bool, force: bool
) -> dict:
    """Download -> index -> delete one book. Returns a row for the final summary."""
    book = book_key(subject, grade)
    src = SOURCES / book / "english"
    row = {"book": book, "status": "", "chapters": 0, "chunks": 0}

    print(f"\n{'=' * 72}\n{book_title(book)}  [{book}]\n{'=' * 72}")

    if already_built(subject, grade) and not force:
        print("  index already present — skipping (use --force to rebuild)")
        row["status"] = "skipped (exists)"
        return row

    # ---- download
    print(f"  downloading {STEMS[subject][grade]}* -> {src}")
    try:
        chapters = download_book(subject, grade)
    except DownloadFailed as e:
        # Network trouble, not a missing book: keep the existing index (if any) and
        # move on. Re-running picks this book up, and cached PDFs are not re-fetched.
        print(f"  download failed: {e}")
        row["status"] = "FAILED (network)"
        return row
    row["chapters"] = chapters
    if not chapters:
        print("  no chapter PDFs found — wrong stem or site layout changed")
        row["status"] = "FAILED (no PDFs)"
        return row
    print(f"  {chapters} chapter PDFs")

    # ---- extract + embed + write index (build_index does all of it)
    # Applied to every book, not just Science: the current NCF Maths books (Joyful
    # Mathematics, Maths Mela, Ganita Prakash, Ganita Manjari) use the same mixed-case
    # running head as Science — "I'm Up and Down, and Round and Round\n93",
    # "Ganita Manjari |Grade 9| Part I\n94" — which build_index's ALL-CAPS rules miss,
    # leaving every printed page wrong (Class 9 Maths: every chapter started at page 1;
    # Class 6 Maths produced a printed page of -17). Only the legacy Class 10 Maths book
    # matches the original rules, and it still does: the patch falls back to them.
    patch_header_rules()
    try:
        bi.build_one(http, key, book, "english")
    except Exception as e:  # keep going: one bad book shouldn't lose the whole run
        print(f"  ERROR building {book}: {type(e).__name__}: {e}")
        row["status"] = f"FAILED ({type(e).__name__})"
        return row
    finally:
        unpatch()

    if not already_built(subject, grade):
        row["status"] = "FAILED (no index written)"
        return row

    import json

    meta = json.loads((index_dir(subject, grade) / "meta.json").read_text(encoding="utf-8"))
    row["chunks"] = meta.get("count", 0)

    # ---- delete the PDFs, now that the index that replaces them exists
    if keep_pdfs:
        row["status"] = "built (PDFs kept)"
    else:
        shutil.rmtree(src, ignore_errors=True)
        parent = src.parent
        if parent.exists() and not any(parent.iterdir()):
            parent.rmdir()
        print(f"  deleted source PDFs ({src})")
        row["status"] = "built"
    return row


# ---------------------------------------------------------------- main


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--grades", nargs="+", type=int, default=GRADES, help="class numbers 1-10")
    p.add_argument("--subject", nargs="+", choices=SUBJECTS, default=SUBJECTS)
    p.add_argument("--keep-pdfs", action="store_true", help="don't delete the source PDFs")
    p.add_argument("--force", action="store_true", help="rebuild books that already have an index")
    p.add_argument("--dry-run", action="store_true", help="list the plan; download nothing")
    args = p.parse_args()

    for g in args.grades:
        if g not in GRADES:
            sys.exit(f"unsupported class {g}; supported: 1-10")

    plan: list[tuple[str, int]] = []
    for subject in args.subject:
        for grade in args.grades:
            if (subject, grade) in SKIPPED:
                print(f"skip ncert-class-{grade}-{subject}: {SKIPPED[(subject, grade)]}")
                continue
            if grade not in STEMS[subject]:
                print(f"skip ncert-class-{grade}-{subject}: no known PDF stem")
                continue
            plan.append((subject, grade))

    if not plan:
        sys.exit("nothing to build")

    print(f"\n{len(plan)} book(s) to build:")
    for subject, grade in plan:
        state = "has index" if already_built(subject, grade) else "to build"
        print(f"  {book_key(subject, grade):28} {STEMS[subject][grade]:7} ({state})")
    if args.dry_run:
        print("\n--dry-run: nothing downloaded.")
        return

    key = bi.api_key()  # fails fast if NVIDIA_API_KEY is missing, before any download
    http = httpx.Client(timeout=120)
    started = time.perf_counter()
    rows = [
        build_book(http, key, s, g, keep_pdfs=args.keep_pdfs, force=args.force) for s, g in plan
    ]

    print(f"\n{'=' * 72}\nSummary ({(time.perf_counter() - started) / 60:.1f} min)\n{'=' * 72}")
    print(f"  {'book':28} {'chapters':>8} {'chunks':>8}  status")
    for r in rows:
        print(f"  {r['book']:28} {r['chapters']:>8} {r['chunks']:>8}  {r['status']}")
    failed = [r for r in rows if r["status"].startswith("FAILED")]
    print(f"\n  {len(rows) - len(failed)}/{len(rows)} ok, indexes under {INDEX}")
    if failed:
        sys.exit(f"  {len(failed)} book(s) failed")


if __name__ == "__main__":
    main()
