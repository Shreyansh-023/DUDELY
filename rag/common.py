"""Paths and naming shared by the RAG ingestion scripts.

Every textbook is identified by the same key the app uses (src/lib/curriculum.ts
textbookKey), e.g. "ncert-class-10-maths", and has one folder per edition (language):

    rag/data/sources/<book>/<edition>/*.pdf          NCERT chapter PDFs (input)
    rag/data/pages/<book>/<edition>/<pdf stem>/      one Markdown file per page
    rag/data/index/<book>/<edition>/                 chunks.json + vectors.f32 + meta.json (read by the app)

rag/data/ is git-ignored: the PDFs are NCERT copyright ("not to be republished") and
everything else is regenerated from them.
"""

import re
from pathlib import Path

RAG_DIR = Path(__file__).resolve().parent
DATA = RAG_DIR / "data"
SOURCES = DATA / "sources"
PAGES = DATA / "pages"
INDEX = DATA / "index"

OLLAMA = "http://localhost:11434"
SUBJECT_NAMES = {"maths": "Mathematics", "science": "Science"}


def book_title(book: str) -> str:
    """"ncert-class-10-maths" -> "NCERT Class 10 Mathematics"."""
    m = re.fullmatch(r"ncert-class-(\d+)-(\w+)", book)
    if not m:
        return book
    return f"NCERT Class {m.group(1)} {SUBJECT_NAMES.get(m.group(2), m.group(2).capitalize())}"
