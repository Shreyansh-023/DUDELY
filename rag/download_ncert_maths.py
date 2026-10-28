"""Download NCERT English Maths chapter PDFs for classes 1–9 into rag/data/sources.

Uses the current NCF / rationalised English editions (2023–25):

    Class 1–2  Joyful Mathematics   aejm1 / bejm1
    Class 3–5  Maths Mela           cemm1 / demm1 / eemm1
    Class 6–8  Ganita Prakash       fegp1 / gegp1 / hegp1
    Class 9    Mathematics          iemh1

    python rag/download_ncert_maths.py
    python rag/download_ncert_maths.py --grades 1 2 3
"""

from __future__ import annotations

import argparse
import sys
import urllib.error
import urllib.request
from pathlib import Path

from common import SOURCES

BASE = "https://ncert.nic.in/textbook/pdf"

# Preferred English stem prefix per class (chapter files are {stem}{NN}.pdf).
STEMS: dict[int, str] = {
    1: "aejm1",
    2: "bejm1",
    3: "cemm1",
    4: "demm1",
    5: "eemm1",
    6: "fegp1",
    7: "gegp1",
    8: "hegp1",
    9: "iemh1",
}

# Soft caps so we stop probing after a gap; real chapter counts are lower.
MAX_CHAPTER = 20


def book_key(grade: int) -> str:
    return f"ncert-class-{grade}-maths"


UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def download(url: str, dest: Path, retries: int = 4) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 10_000:
        print(f"  keep {dest.name} ({dest.stat().st_size} bytes)")
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
        # brief backoff — NCERT often drops bare / repeated connections
        import time

        time.sleep(1.5 * (attempt + 1))
    else:
        raise last_err  # type: ignore[misc]
    if len(data) < 10_000:
        print(f"  skip {dest.name} (too small: {len(data)})")
        return False
    dest.write_bytes(data)
    print(f"  got  {dest.name} ({len(data)} bytes)")
    return True


def download_grade(grade: int) -> int:
    stem = STEMS[grade]
    out = SOURCES / book_key(grade) / "english"
    print(f"\n{book_key(grade)} <- {stem}* -> {out}")
    count = 0
    misses = 0
    for n in range(1, MAX_CHAPTER + 1):
        code = f"{stem}{n:02d}"
        ok = download(f"{BASE}/{code}.pdf", out / f"{code}.pdf")
        if ok:
            count += 1
            misses = 0
        else:
            misses += 1
            if misses >= 2 and count > 0:
                break
            if count == 0 and misses >= 2:
                break
    # Optional prelims (ps) — useful for outlines; ignore if missing.
    download(f"{BASE}/{stem}ps.pdf", out / f"{stem}ps.pdf")
    print(f"  → {count} chapter PDFs")
    return count


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--grades", nargs="+", type=int, default=list(range(1, 10)), help="class numbers 1–9")
    args = p.parse_args()
    total = 0
    for g in args.grades:
        if g not in STEMS:
            sys.exit(f"unsupported grade {g}; supported: {sorted(STEMS)}")
        total += download_grade(g)
    print(f"\nDone. {total} chapter PDFs under {SOURCES}")


if __name__ == "__main__":
    main()
