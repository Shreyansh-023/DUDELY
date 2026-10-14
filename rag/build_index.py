"""Build a textbook retrieval index the app reads, using NVIDIA Nemotron embeddings.

No local model and no Ollama: pages are extracted as plain text with PyMuPDF and the
chunks are embedded by the hosted Nemotron-3-Embed-1B NIM (input_type="passage").
The matching query-side embedding lives in src/lib/rag.ts (input_type="query").

Layout (see rag/common.py):
    rag/data/sources/<book>/<edition>/*.pdf          input PDFs
    rag/data/index/<book>/<edition>/                 meta.json + chunks.json + vectors.f32 (output)

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


def extract_chunks(book: str, edition: str) -> list[dict]:
    titles = TITLES.get(book, {})
    src = SOURCES / book / edition
    pdfs = sorted(src.glob("*.pdf"))
    if not pdfs:
        sys.exit(f"no PDFs in {src}")
    chunks: list[dict] = []
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
        for pno in range(doc.page_count):
            txt = clean(doc[pno].get_text())
            if len(txt) < 40:
                continue
            for c in chunk_paras(txt.split("\n\n")):
                c = c.strip()
                if len(c) < 40:
                    continue
                chunks.append(
                    {"id": cid, "stem": pdf.stem, "chapter": ch, "label": label,
                     "pages": [pno + 1, pno + 1], "kind": kind, "text": c}
                )
                cid += 1
        print(f"  {pdf.name}: {label} — {doc.page_count} pages")
    return chunks


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
        chunks = extract_chunks(args.book, edition)
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
        (out_dir / "meta.json").write_text(
            json.dumps({"book": args.book, "edition": edition, "embedModel": EMBED_MODEL,
                        "dim": dim, "count": len(chunks)}),
            encoding="utf-8",
        )
        mins = (time.perf_counter() - started) / 60
        print(f"  wrote {len(chunks)} chunks x {dim}d to {out_dir} in {mins:.1f} min")


if __name__ == "__main__":
    main()
