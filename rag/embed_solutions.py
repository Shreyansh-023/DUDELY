"""Embed the parsed solution Q/A pairs into the vector index the app reads.

Input is rag/data/solutions/solutions.json (built by build_solutions.py); the output
matches the layout build_index.py already writes, so src/lib/rag.ts can mmap it the
same way:

    rag/data/index/solutions/<book>/     meta.json + chunks.json + vectors.f32

    python rag/embed_solutions.py                      # every class/subject
    python rag/embed_solutions.py --book ncert-class-10-maths
    python rag/embed_solutions.py --dry-run            # chunk + report, no API calls
    python rag/embed_solutions.py --force              # re-embed books already current

Re-running is cheap: a book whose index already matches its chunk count and embedding
model is skipped, so an interrupted run resumes where it stopped.

One chunk is one whole Q/A pair, not a fixed-size window: the pairs are the natural
unit here, so a question is never retrieved without its answer. The embedded text
carries a short header (class/subject/chapter/exercise) so a query that names a
position has something to match on besides the maths itself.

Needs NVIDIA_API_KEY in the environment or in .env at the repo root.
"""

import argparse
import array
import json
import sys
import time
from pathlib import Path

import httpx

from build_index import BATCH, EMBED_MODEL, api_key, embed_passages, l2_normalize
from common import DATA, INDEX

# The hosted NIM occasionally drops a response mid-body on a long run.
RETRIES = 4

SOLUTIONS_JSON = DATA / "solutions" / "solutions.json"
OUT_ROOT = INDEX / "solutions"

SUBJECT_SLUG = {"Mathematics": "maths", "Science": "science", "EVS": "evs"}

# An answer this short is a picture in the PDF, so there is nothing to embed; the
# question still is worth indexing, and the flag tells the app to solve it itself.
MIN_ANSWER = 5


def book_key(record: dict) -> str:
    slug = SUBJECT_SLUG.get(record["subject"], record["subject"].lower())
    return f"ncert-class-{record['class']}-{slug}"


def passage(r: dict) -> str:
    """The text that gets embedded: a locating header, then the Q and its answer."""
    bits = [f"Class {r['class']} {r['subject']}"]
    if r.get("chapter"):
        title = r.get("chapter_title") or ""
        bits.append(f"Chapter {r['chapter']}{': ' + title if title else ''}")
    if r.get("exercise"):
        bits.append(f"Exercise {r['exercise']}")
    elif r.get("section"):
        bits.append(r["section"])
    if r.get("number"):
        bits.append(f"Q{r['number']}")
    head = " | ".join(bits)

    body = f"Question: {r['question']}"
    if len(r["answer"]) >= MIN_ANSWER:
        body += f"\nAnswer: {r['answer']}"
    else:
        # Say so explicitly rather than embedding a dangling "Answer:".
        body += "\n(The printed solution for this question is a diagram.)"
    return f"{head}\n{body}"


def to_chunks(records: list[dict]) -> dict[str, list[dict]]:
    by_book: dict[str, list[dict]] = {}
    for r in records:
        by_book.setdefault(book_key(r), []).append({
            "id": r["id"],
            "text": passage(r),
            "class": r["class"],
            "subject": r["subject"],
            "chapter": r.get("chapter"),
            "chapterTitle": r.get("chapter_title"),
            "section": r.get("section"),
            "exercise": r.get("exercise"),
            "number": r.get("number"),
            "question": r["question"],
            "answer": r["answer"],
            "hasImageAnswer": r["has_image_answer"],
            "mathQuality": r["math_quality"],
            "textbookPage": r.get("textbook_page"),
            "sourcePdf": r["source_pdf"],
            "kind": "solution",
        })
    return by_book


def embed_with_retry(http: httpx.Client, key: str, texts: list[str]) -> list[list[float]]:
    """embed_passages, but tolerate a dropped connection instead of losing the run."""
    for attempt in range(1, RETRIES + 1):
        try:
            return embed_passages(http, key, texts)
        except (httpx.HTTPError, RuntimeError) as exc:
            if attempt == RETRIES:
                raise
            wait = 2 ** attempt
            print(f"\n  {type(exc).__name__}: {str(exc)[:120]}"
                  f"\n  retry {attempt}/{RETRIES - 1} in {wait}s")
            time.sleep(wait)
    raise AssertionError("unreachable")


def already_done(book: str, n: int) -> bool:
    """True if this book's index is present and matches the chunk count."""
    out_dir = OUT_ROOT / book
    meta_path, vec_path = out_dir / "meta.json", out_dir / "vectors.f32"
    if not (meta_path.exists() and vec_path.exists()):
        return False
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False
    return (meta.get("count") == n and meta.get("embedModel") == EMBED_MODEL
            and vec_path.stat().st_size == n * meta.get("dim", 0) * 4)


def write_book(book: str, chunks: list[dict], vecs: list[list[float]] | None) -> Path:
    out_dir = OUT_ROOT / book
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "chunks.json").write_text(json.dumps(chunks, ensure_ascii=False), encoding="utf-8")
    dim = 0
    if vecs:
        flat = array.array("f")
        for v in vecs:
            flat.extend(l2_normalize(v))
        (out_dir / "vectors.f32").write_bytes(flat.tobytes())
        dim = len(vecs[0])
    (out_dir / "meta.json").write_text(
        json.dumps({"book": book, "kind": "solutions", "embedModel": EMBED_MODEL,
                    "dim": dim, "count": len(chunks)}),
        encoding="utf-8",
    )
    return out_dir


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", nargs="*", help="only these book keys (default: all)")
    ap.add_argument("--input", type=Path, default=SOLUTIONS_JSON)
    ap.add_argument("--dry-run", action="store_true", help="chunk and report; no embedding")
    ap.add_argument("--force", action="store_true", help="re-embed books that are already current")
    args = ap.parse_args()

    if not args.input.exists():
        sys.exit(f"missing {args.input} — run build_solutions.py first")
    records = json.loads(args.input.read_text(encoding="utf-8"))
    by_book = to_chunks(records)
    if args.book:
        by_book = {k: v for k, v in by_book.items() if k in set(args.book)}
        if not by_book:
            sys.exit("no book matched --book")

    total = sum(len(v) for v in by_book.values())
    print(f"{total} Q/A chunks across {len(by_book)} books")
    for book in sorted(by_book):
        n = len(by_book[book])
        img = sum(1 for c in by_book[book] if c["hasImageAnswer"])
        poor = sum(1 for c in by_book[book] if c["mathQuality"] == "poor")
        print(f"  {book:<28} {n:>5} chunks  ({img} diagram-only, {poor} poor-maths)")

    if args.dry_run:
        print("\n--dry-run: nothing embedded. Sample passage:")
        first = by_book[sorted(by_book)[0]][0]
        print("-" * 80)
        print(first["text"][:700])
        print("-" * 80)
        return

    key = api_key()
    started = time.perf_counter()
    done = skipped = 0
    with httpx.Client(timeout=120) as http:
        for book in sorted(by_book):
            chunks = by_book[book]
            if not args.force and already_done(book, len(chunks)):
                print(f"\n{book} ({len(chunks)} chunks) — up to date, skipping")
                skipped += 1
                continue
            print(f"\n{book} ({len(chunks)} chunks)")
            vecs = embed_with_retry(http, key, [c["text"] for c in chunks])
            out = write_book(book, chunks, vecs)
            done += 1
            print(f"  wrote {len(chunks)} x {len(vecs[0])}d to {out}")
    print(f"\n{done} books embedded, {skipped} already current "
          f"({(time.perf_counter() - started) / 60:.1f} min)")


if __name__ == "__main__":
    main()
