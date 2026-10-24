"""Offline RAG accuracy checks for NCERT maths indexes (classes 1-10).

Tests:
  1. Structural lookup (Example / Exercise / Theorem) against structure.json
  2. Hybrid retrieval (BM25 + Nemotron embeddings) for concept questions
  3. Spot-checks that top hits land in the expected chapter / contain key phrases

    PYTHONPATH=rag python rag/eval_retrieval.py
"""

from __future__ import annotations

import array
import json
import math
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from common import INDEX

EMBED_URL = os.environ.get("NVIDIA_EMBED_URL", "https://integrate.api.nvidia.com/v1/embeddings")
EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "nvidia/nemotron-3-embed-1b")
TOP_K = 3
CANDIDATES = 30
RRF_K = 60
BM25_WEIGHT = 0.5


def api_key() -> str:
    key = os.environ.get("NVIDIA_API_KEY")
    if not key:
        env = Path(__file__).resolve().parent.parent / ".env"
        if env.exists():
            m = re.search(r"^\s*NVIDIA_API_KEY\s*=\s*(.+)\s*$", env.read_text(encoding="utf-8"), re.M)
            if m:
                key = m.group(1).strip().strip('"').strip("'")
    if not key:
        sys.exit("NVIDIA_API_KEY not set")
    return key


@dataclass
class CaseResult:
    name: str
    ok: bool
    detail: str
    kind: str = "check"


@dataclass
class BookReport:
    book: str
    results: list[CaseResult] = field(default_factory=list)

    @property
    def passed(self) -> int:
        return sum(1 for r in self.results if r.ok)

    @property
    def total(self) -> int:
        return len(self.results)


def load_book(book: str, edition: str = "english"):
    d = INDEX / book / edition
    if not d.exists():
        return None
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    chunks = json.loads((d / "chunks.json").read_text(encoding="utf-8"))
    struct = json.loads((d / "structure.json").read_text(encoding="utf-8"))
    raw = (d / "vectors.f32").read_bytes()
    vecs = array.array("f")
    vecs.frombytes(raw)
    dim = meta["dim"]
    count = meta["count"]
    assert len(vecs) == count * dim, f"vector size mismatch for {book}"
    return {"meta": meta, "chunks": chunks, "structure": struct, "vecs": vecs, "dim": dim, "count": count}


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9\u0900-\u097f]+", text.lower())


def build_bm25(chunks: list[dict]):
    docs = [tokenize(c["text"]) for c in chunks]
    N = len(docs) or 1
    df: Counter[str] = Counter()
    for toks in docs:
        df.update(set(toks))
    avgdl = sum(len(t) for t in docs) / N
    return docs, df, avgdl, N


def bm25_scores(query: str, docs, df, avgdl, N, k1=1.2, b=0.75) -> list[float]:
    q = tokenize(query)
    scores = [0.0] * len(docs)
    for i, toks in enumerate(docs):
        if not toks:
            continue
        tf = Counter(toks)
        dl = len(toks)
        s = 0.0
        for t in q:
            if t not in tf:
                continue
            n_q = df.get(t, 0)
            idf = math.log(1 + (N - n_q + 0.5) / (n_q + 0.5))
            s += idf * (tf[t] * (k1 + 1)) / (tf[t] + k1 * (1 - b + b * dl / avgdl))
        scores[i] = s
    return scores


def embed_query(http: httpx.Client, key: str, text: str) -> list[float] | None:
    r = http.post(
        EMBED_URL,
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
        json={"model": EMBED_MODEL, "input": [text], "input_type": "query"},
        timeout=60,
    )
    r.raise_for_status()
    v = r.json()["data"][0]["embedding"]
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def hybrid_search(idx, http, key, query: str, k: int = TOP_K) -> list[dict]:
    chunks, vecs, dim, count = idx["chunks"], idx["vecs"], idx["dim"], idx["count"]
    docs, df, avgdl, N = build_bm25(chunks)
    fused: dict[int, float] = {}

    def add(ranked: list[int], weight: float):
        for r, i in enumerate(ranked):
            fused[i] = fused.get(i, 0.0) + weight / (RRF_K + r + 1)

    q = embed_query(http, key, query)
    if q and len(q) == dim:
        sims = []
        for i in range(count):
            off = i * dim
            s = 0.0
            for d in range(dim):
                s += vecs[off + d] * q[d]
            sims.append(s)
        ranked = sorted(range(count), key=lambda i: sims[i], reverse=True)[:CANDIDATES]
        add(ranked, 1.0)

    bm = bm25_scores(query, docs, df, avgdl, N)
    ranked_bm = [i for i in sorted(range(count), key=lambda i: bm[i], reverse=True)[:CANDIDATES] if bm[i] > 0]
    add(ranked_bm, BM25_WEIGHT if q else 1.0)

    order = sorted(fused.keys(), key=lambda i: fused[i], reverse=True)[:k]
    return [chunks[i] for i in order]


def chapter_of(chunk: dict) -> int | None:
    if chunk.get("chapter") is not None:
        return chunk["chapter"]
    m = re.search(r"Chapter\s+(\d+)", chunk.get("label") or "")
    return int(m.group(1)) if m else None


def expect_chapter(hits: list[dict], want: int) -> tuple[bool, str]:
    chs = [chapter_of(h) for h in hits]
    labels = [h.get("label", "?") for h in hits]
    ok = want in chs[:2] or (chs and chs[0] == want)
    return ok, f"want ch{want}; got {labels}"


def expect_phrases(text: str, phrases: list[str], need: int = 1) -> tuple[bool, str]:
    low = text.lower()
    found = [p for p in phrases if p.lower() in low]
    ok = len(found) >= need
    return ok, f"found {found or 'none'} of {phrases}"


# --------------------------------------------------------------------------- cases

# Structural: only Class 10 has rich Example/Exercise extraction from classic NCERT.
STRUCTURAL_CASES = [
    {
        "book": "ncert-class-10-maths",
        "q": "example 2 of chapter 1",
        "check": "example",
        "chapter": "1",
        "num": "2",
        "phrases": ["fundamental theorem", "HCF", "prime", "Euclid", "factor"],
    },
    {
        "book": "ncert-class-10-maths",
        "q": "example 1 of chapter 4",
        "check": "example",
        "chapter": "4",
        "num": "1",
        "phrases": ["quadratic", "equation", "root", "x"],
    },
    {
        "book": "ncert-class-10-maths",
        "q": "exercise 1.1 question 1",
        "check": "exercise_q",
        "ref": "1.1",
        "qnum": "1",
        "phrases": ["use", "Euclid", "algorithm", "HCF", "find"],
    },
    {
        "book": "ncert-class-10-maths",
        "q": "theorem 1.2",
        "check": "theorem",
        "ref": "1.2",
        "phrases": ["irrational", "prime", "sqrt", "√", "p"],
    },
]

# Semantic concept questions — expected chapter from the book's TITLES / syllabus.
SEMANTIC_CASES = [
    # Class 10 classic
    {"book": "ncert-class-10-maths", "q": "what is a quadratic equation", "chapter": 4, "phrases": ["quadratic"]},
    {"book": "ncert-class-10-maths", "q": "trigonometric ratios sine cosine", "chapter": 8, "phrases": ["sin", "cos", "trigonometr"]},
    {"book": "ncert-class-10-maths", "q": "arithmetic progression common difference", "chapter": 5, "phrases": ["progression", "common difference", "AP"]},
    # Class 9 Ganita Manjari
    {"book": "ncert-class-9-maths", "q": "cartesian coordinates plane plot a point", "chapter": 1, "phrases": ["coordinate", "axis", "plane"]},
    {"book": "ncert-class-9-maths", "q": "introduction to probability chance", "chapter": 7, "phrases": ["probabilit", "chance", "outcome"]},
    {"book": "ncert-class-9-maths", "q": "algebraic identities (a+b)^2", "chapter": 4, "phrases": ["identit", "algebra"]},
    # Class 8 Ganita Prakash
    {"book": "ncert-class-8-maths", "q": "square numbers and cube numbers", "chapter": 1, "phrases": ["square", "cube"]},
    {"book": "ncert-class-8-maths", "q": "what is a quadrilateral", "chapter": 4, "phrases": ["quadrilateral", "side", "angle"]},
    # Class 7
    {"book": "ncert-class-7-maths", "q": "parallel lines and transversal", "chapter": 5, "phrases": ["parallel", "line"]},
    {"book": "ncert-class-7-maths", "q": "working with fractions addition", "chapter": 8, "phrases": ["fraction"]},
    # Class 6
    {"book": "ncert-class-6-maths", "q": "what are prime numbers factorization", "chapter": 5, "phrases": ["prime"]},
    {"book": "ncert-class-6-maths", "q": "perimeter and area of a rectangle", "chapter": 6, "phrases": ["perimeter", "area"]},
    {"book": "ncert-class-6-maths", "q": "negative numbers on the number line", "chapter": 10, "phrases": ["negative", "zero", "number"]},
    # Class 5 Maths Mela
    {"book": "ncert-class-5-maths", "q": "what are fractions halves thirds", "chapter": 2, "phrases": ["fraction"]},
    {"book": "ncert-class-5-maths", "q": "angles as turns full half quarter", "chapter": 3, "phrases": ["angle", "turn"]},
    # Class 4
    {"book": "ncert-class-4-maths", "q": "measuring length centimetre metre", "chapter": 6, "phrases": ["length", "measur"]},
    {"book": "ncert-class-4-maths", "q": "equal groups multiplication", "chapter": 9, "phrases": ["group", "equal", "multipl"]},
    # Class 3
    {"book": "ncert-class-3-maths", "q": "fun with shapes triangles circles", "chapter": 5, "phrases": ["shape"]},
    {"book": "ncert-class-3-maths", "q": "fair share division sharing equally", "chapter": 8, "phrases": ["share", "fair", "equal"]},
    # Class 2
    {"book": "ncert-class-2-maths", "q": "shapes around us 3D cube sphere", "chapter": 2, "phrases": ["shape"]},
    {"book": "ncert-class-2-maths", "q": "grouping and sharing multiplication division", "chapter": 8, "phrases": ["group", "shar"]},
    # Class 1
    {"book": "ncert-class-1-maths", "q": "what is long what is round shapes", "chapter": 2, "phrases": ["long", "round", "shape"]},
    {"book": "ncert-class-1-maths", "q": "making 10 numbers ten twenty", "chapter": 4, "phrases": ["10", "ten", "number"]},
]


def run_structural(idx, case) -> CaseResult:
    name = f"structural: {case['q']}"
    st = idx["structure"]
    check = case["check"]
    text = ""
    label = ""
    if check == "example":
        u = st.get("examples", {}).get(case["chapter"], {}).get(case["num"])
        if not u:
            return CaseResult(name, False, f"missing Example {case['num']} ch{case['chapter']}", "structural")
        text, label = u["text"], f"Ex {case['num']} ch{case['chapter']}"
    elif check == "theorem":
        u = st.get("theorems", {}).get(case["ref"])
        if not u:
            return CaseResult(name, False, f"missing Theorem {case['ref']}", "structural")
        text, label = u["text"], f"Th {case['ref']}"
    elif check == "exercise_q":
        u = st.get("exercises", {}).get(case["ref"])
        if not u:
            return CaseResult(name, False, f"missing Exercise {case['ref']}", "structural")
        q = u.get("questions", {}).get(case["qnum"])
        if not q:
            return CaseResult(name, False, f"missing Q{case['qnum']} in Ex {case['ref']}", "structural")
        text, label = q["text"], f"Ex {case['ref']} Q{case['qnum']}"
    ok, detail = expect_phrases(text, case["phrases"], need=1)
    return CaseResult(name, ok, f"{label}: {detail} | snippet={text[:120]!r}", "structural")


def run_semantic(idx, http, key, case) -> CaseResult:
    name = f"semantic: {case['q'][:48]}"
    try:
        hits = hybrid_search(idx, http, key, case["q"])
    except Exception as e:
        return CaseResult(name, False, f"embed/search error: {e}", "semantic")
    if not hits:
        return CaseResult(name, False, "no hits", "semantic")
    ok_ch, detail_ch = expect_chapter(hits, case["chapter"])
    blob = " ".join(h["text"] for h in hits)
    ok_ph, detail_ph = expect_phrases(blob, case["phrases"], need=1)
    # Pass if chapter is correct OR (phrases match AND chapter within ±1 of a top-3 hit)
    chs = [chapter_of(h) for h in hits]
    near = case["chapter"] in chs
    ok = (ok_ch or near) and ok_ph
    if not ok and near and ok_ph:
        ok = True
    if not ok and ok_ph and any(c == case["chapter"] for c in chs):
        ok = True
    return CaseResult(name, ok, f"{detail_ch}; {detail_ph}", "semantic")


def index_health(idx) -> list[CaseResult]:
    out = []
    meta = idx["meta"]
    out.append(CaseResult(
        "index meta",
        meta.get("count", 0) > 0 and meta.get("dim") == 2048,
        f"count={meta.get('count')} dim={meta.get('dim')} model={meta.get('embedModel')}",
        "health",
    ))
    st = idx["structure"]
    n_ex = sum(len(v) for v in st.get("examples", {}).values())
    n_exr = len(st.get("exercises", {}))
    n_sec = sum(len(v) for v in st.get("sections", {}).values())
    out.append(CaseResult(
        "structure present",
        True,  # always informative; primary books may be 0/0/0
        f"examples={n_ex} exercises={n_exr} sections={n_sec} theorems={len(st.get('theorems', {}))}",
        "health",
    ))
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    key = api_key()
    http = httpx.Client(timeout=90)
    books = [f"ncert-class-{g}-maths" for g in range(1, 11)]
    reports: list[BookReport] = []

    for book in books:
        rep = BookReport(book=book)
        idx = load_book(book)
        if not idx:
            rep.results.append(CaseResult("index exists", False, "missing index folder", "health"))
            reports.append(rep)
            continue
        print(f"\n=== {book} ({idx['meta']['count']} chunks) ===")
        rep.results.extend(index_health(idx))

        for case in STRUCTURAL_CASES:
            if case["book"] != book:
                continue
            r = run_structural(idx, case)
            rep.results.append(r)
            print(f"  [{'PASS' if r.ok else 'FAIL'}] {r.name}: {r.detail[:160]}")

        for case in SEMANTIC_CASES:
            if case["book"] != book:
                continue
            r = run_semantic(idx, http, key, case)
            rep.results.append(r)
            print(f"  [{'PASS' if r.ok else 'FAIL'}] {r.name}: {r.detail[:160]}")

        reports.append(rep)

    # ---- summary
    print("\n" + "=" * 72)
    print("RAG RETRIEVAL ACCURACY REPORT")
    print("=" * 72)
    total_pass = total = 0
    for rep in reports:
        scored = [r for r in rep.results if r.kind in ("structural", "semantic")]
        hp = sum(1 for r in scored if r.ok)
        ht = len(scored)
        total_pass += hp
        total += ht
        status = "OK" if ht and hp == ht else ("PARTIAL" if hp else ("NO TESTS" if ht == 0 else "FAIL"))
        print(f"{rep.book:28} {hp}/{ht} content checks  [{status}]")
        for r in rep.results:
            if r.kind == "health":
                print(f"    · {r.name}: {r.detail}")
            elif not r.ok:
                print(f"    ✗ {r.name}: {r.detail[:140]}")

    print("-" * 72)
    pct = (100 * total_pass / total) if total else 0
    print(f"TOTAL content checks: {total_pass}/{total} ({pct:.0f}%)")
    print()
    print("Notes:")
    print("- Structural Example/Exercise/Theorem checks apply mainly to Class 10")
    print("  (classic NCERT headings). NCF books (1-9) rely on semantic retrieval.")
    print("- A PASS means the index returned the right chapter / unit with matching")
    print("  keywords — not that the live LLM tutor phrased a perfect spoken lesson.")
    out = Path(__file__).resolve().parent.parent / ".tmp" / "rag_eval_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "total_pass": total_pass,
        "total": total,
        "pct": pct,
        "books": [
            {
                "book": r.book,
                "results": [{"name": x.name, "ok": x.ok, "kind": x.kind, "detail": x.detail} for x in r.results],
            }
            for r in reports
        ],
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
