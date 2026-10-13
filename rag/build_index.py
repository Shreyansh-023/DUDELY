"""Build the retrieval index for one textbook from its converted pages.

Pages are split into passages along the book's own headings (a passage never spans two
sections), each labelled with chapter, section and pages, then embedded with bge-m3 via
Ollama. The app embeds questions with the same model (src/lib/rag.ts), so both sides
match. Output, per edition:

    rag/data/index/<book>/<edition>/chunks.json    passages + labels + metadata
    rag/data/index/<book>/<edition>/vectors.f32    float32 row-major, L2-normalised
    rag/data/index/<book>/<edition>/meta.json      model, dimension, counts

    python rag/build_index.py --book ncert-class-10-maths --edition english hindi
"""

import argparse
import json
import math
import re
import sys
import time
from array import array
from datetime import datetime

import httpx

from common import INDEX, OLLAMA, PAGES, book_title

EMBED_MODEL = "bge-m3"
MAX_WORDS = 220            # target passage size; a section is packed into passages up to this
EXERCISE = re.compile(r"EXERCISE|प्रश्नावली", re.I)
LABELS = {
    "english": {"chapter": "Chapter", "appendix": "Appendix", "answers": "Answers to exercises"},
    "hindi": {"chapter": "अध्याय", "appendix": "परिशिष्ट", "answers": "प्रश्नावलियों के उत्तर"},
}


def classify(stem: str) -> tuple[str, int | None]:
    """NCERT file stems end in the chapter: jemh104 -> chapter 4, jemh1a1 -> appendix 1,
    jemh1an -> answers, jemh1ps -> preliminary pages (skipped)."""
    tail = stem[-2:]
    if tail.isdigit():
        return "chapter", int(tail)
    if tail[0] == "a" and tail[1].isdigit():
        return "appendix", int(tail[1])
    return {"an": "answers", "ps": "prelims"}.get(tail, "other"), None


def clean_title(heading: str) -> str:
    t = re.sub(r"^\s*(chapter|अध्याय)?\s*\d+\s*[:.\-]?\s*", "", heading.lstrip("#").strip(), flags=re.I)
    t = re.sub(r"\s*\d+\s*$", "", t)                          # "QUADRATIC EQUATIONS 4"
    return t.title() if t.isascii() and t.isupper() else t


def page_blocks(md: str) -> list[tuple[str, str]]:
    """Split a page into ('heading1'|'heading2'|'heading3'|'para', text) blocks."""
    blocks, para = [], []

    def flush():
        if para:
            blocks.append(("para", "\n".join(para).strip()))
            para.clear()

    for line in md.splitlines():
        m = re.match(r"^(#{1,3})\s+(.*)", line)
        if m:
            flush()
            blocks.append((f"heading{len(m.group(1))}", m.group(2).strip()))
        elif not line.strip():
            flush()
        else:
            para.append(line)
    flush()
    return [b for b in blocks if b[1]]


def chunk_book(book: str, edition: str) -> list[dict]:
    words = LABELS.get(edition, LABELS["english"])
    chunks = []
    for stem_dir in sorted((PAGES / book / edition).iterdir()):
        kind, number = classify(stem_dir.name)
        if kind in ("prelims", "other"):
            continue
        title, section, subsection = None, "", ""
        buf: list[str] = []
        buf_pages: list[int] = []

        def label() -> str:
            if kind == "answers":
                head = words["answers"]
            else:
                head = f"{words[kind]} {number}" + (f": {title}" if title else "")
            path = " › ".join(x for x in (section, subsection) if x)
            return f"{head} › {path}" if path else head

        def flush():
            text = "\n\n".join(buf).strip()
            if text:
                chunks.append({
                    "id": len(chunks),
                    "stem": stem_dir.name,
                    "kind": "answers" if kind == "answers" else
                            "exercise" if EXERCISE.search(section) else kind,
                    "chapter": number if kind == "chapter" else None,
                    "label": label(),
                    "pages": [min(buf_pages), max(buf_pages)],
                    "text": text,
                })
            buf.clear()
            buf_pages.clear()

        for page_file in sorted(stem_dir.glob("page_*.md")):
            page = int(page_file.stem.split("_")[1])
            for btype, text in page_blocks(page_file.read_text(encoding="utf-8")):
                if btype == "heading1":
                    # The first level-1 heading is the chapter title; later ones are usually
                    # a running header that slipped through, so they are ignored.
                    if title is None and kind != "answers":
                        title = clean_title(text)
                    continue
                if btype in ("heading2", "heading3"):
                    flush()
                    if btype == "heading2":
                        section, subsection = text, ""
                    else:
                        subsection = text
                    continue
                n = len(text.split())
                if buf and sum(len(b.split()) for b in buf) + n > MAX_WORDS:
                    flush()
                buf.append(text)
                buf_pages.append(page)
        flush()
    return chunks


def embed(http: httpx.Client, texts: list[str], batch: int = 16) -> list[list[float]]:
    out = []
    for i in range(0, len(texts), batch):
        r = http.post(f"{OLLAMA}/api/embed", json={"model": EMBED_MODEL, "input": texts[i:i + batch]})
        if r.status_code != 200:
            raise RuntimeError(f"Ollama embed failed: {r.text[:300]}")
        for v in r.json()["embeddings"]:
            norm = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append([x / norm for x in v])
        print(f"  embedded {min(i + batch, len(texts))}/{len(texts)}", end="\r")
    print()
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--book", required=True)
    p.add_argument("--edition", nargs="+", required=True)
    args = p.parse_args()

    http = httpx.Client(timeout=600)
    for edition in args.edition:
        t = time.perf_counter()
        chunks = chunk_book(args.book, edition)
        if not chunks:
            print(f"{edition}: no converted pages in {PAGES / args.book / edition}")
            continue
        kinds = {k: sum(c["kind"] == k for c in chunks) for k in sorted({c["kind"] for c in chunks})}
        print(f"{edition}: {len(chunks)} passages {kinds}")
        # The label goes into the embedded text too: "Chapter 4: Quadratic Equations › 4.3 ..."
        # tells the embedding what the passage is about even when the passage itself is terse.
        vectors = embed(http, [f"{c['label']}\n{c['text']}" for c in chunks])

        out = INDEX / args.book / edition
        out.mkdir(parents=True, exist_ok=True)
        (out / "chunks.json").write_text(json.dumps(chunks, ensure_ascii=False), encoding="utf-8")
        flat = array("f", (x for v in vectors for x in v))
        if sys.byteorder != "little":
            flat.byteswap()
        with open(out / "vectors.f32", "wb") as f:
            flat.tofile(f)
        (out / "meta.json").write_text(json.dumps({
            "book": args.book, "title": book_title(args.book), "edition": edition,
            "embedModel": EMBED_MODEL, "dim": len(vectors[0]), "count": len(chunks),
            "maxWords": MAX_WORDS, "built": datetime.now().isoformat(timespec="seconds"),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{edition}: wrote {out} in {time.perf_counter() - t:.0f}s")


if __name__ == "__main__":
    main()
