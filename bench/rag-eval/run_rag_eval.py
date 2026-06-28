#!/usr/bin/env python3
"""
RAG-evaluation suite for Oxagen's context/retrieval engine.

Scores RETRIEVAL QUALITY using two industry-standard frameworks:
  - RAGAS  : context_precision, context_recall, faithfulness, answer_relevancy
  - DeepEval: ContextualPrecisionMetric, ContextualRecallMetric,
              FaithfulnessMetric, AnswerRelevancyMetric

The Vercel AI Gateway acts as the judge LLM for both frameworks so results
are directly comparable to the engram homegrown metrics (contextPrecision /
contextRecall) in packages/engram/src/eval/metrics.ts.

Metric mapping:
  RAGAS context_precision    ↔ engram contextPrecision
  RAGAS context_recall       ↔ engram contextRecall
  RAGAS faithfulness         ↔ (no direct engram equivalent — faithfulness cross-check)
  RAGAS answer_relevancy     ↔ (no direct engram equivalent — relevancy cross-check)

Dataset schema (dataset.jsonl):
  {"id": str, "question": str, "contexts": [str, ...],
   "answer": str, "ground_truth": str}

The engram TS harness can export a dataset.jsonl in exactly this schema for
round-trip cross-validation (pass it via --dataset or RAG_DATASET).

Usage:
    python bench/rag-eval/run_rag_eval.py
    python bench/rag-eval/run_rag_eval.py --dataset /path/to/dataset.jsonl
    RAG_DATASET=/path/to/export.jsonl python bench/rag-eval/run_rag_eval.py
    RAG_JUDGE_MODEL=openai/gpt-4o python bench/rag-eval/run_rag_eval.py

    # Re-generate contexts + answers from the live oxagen bundle, then score:
    python bench/rag-eval/run_rag_eval.py --gen-context

Prereqs:
    uv venv --python 3.13
    uv pip install -e .
    export AI_GATEWAY_API_KEY=...  (or set in repo .env.local)

API NOTES (version-sensitive — verify against installed packages):
  RAGAS >= 0.2:
    from ragas import evaluate
    from ragas.metrics import (
        context_precision, context_recall,
        faithfulness, answer_relevancy,
    )
    Dataset columns: "question", "contexts" (List[str]), "answer", "ground_truth"
    LLM/embeddings passed as: evaluate(..., llm=<LangChain LLM>, embeddings=<LangChain Embeddings>)
    If RAGAS >= 0.2 uses "response" instead of "answer", swap the column name.

  DeepEval >= 1.4:
    from deepeval.metrics import (
        ContextualPrecisionMetric, ContextualRecallMetric,
        FaithfulnessMetric, AnswerRelevancyMetric,
    )
    from deepeval.test_case import LLMTestCase
    from deepeval import evaluate as deepeval_evaluate
    LLMTestCase(
        input=question,
        actual_output=answer,
        expected_output=ground_truth,
        retrieval_context=contexts,  # List[str]
    )
    Judge configured via env vars OPENAI_API_KEY + OPENAI_BASE_URL before import.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

REPO = Path(os.environ.get("OXAGEN_REPO", Path(__file__).resolve().parents[2]))
BUNDLE = os.environ.get(
    "OXAGEN_CLI_BUNDLE",
    str(REPO / "apps/cli/dist-standalone/oxagen.mjs"),
)
GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1"
JUDGE_MODEL = os.environ.get("RAG_JUDGE_MODEL", "openai/gpt-4o-mini")
EMBED_MODEL = os.environ.get("RAG_EMBED_MODEL", "openai/text-embedding-3-small")
TIMEOUT = int(os.environ.get("EVAL_TIMEOUT", "300"))
DEFAULT_DATASET = Path(__file__).resolve().parent / "dataset.jsonl"
OUT = Path(__file__).resolve().parent / "results.json"


# ---------------------------------------------------------------------------
# Gateway key resolution (mirrors bench/context-eval/run_eval.py)
# ---------------------------------------------------------------------------

def gw_key() -> str:
    """Resolve AI_GATEWAY_API_KEY from env or repo .env.local."""
    key = os.environ.get("AI_GATEWAY_API_KEY")
    if key:
        return key
    env = REPO / ".env.local"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("AI_GATEWAY_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(
        "AI_GATEWAY_API_KEY not set.\n"
        "  Set it in the environment: export AI_GATEWAY_API_KEY=...\n"
        "  Or add it to repo .env.local: AI_GATEWAY_API_KEY=...\n"
    )


# ---------------------------------------------------------------------------
# Lazy import guards — clear error if deps are missing
# ---------------------------------------------------------------------------

def _import_ragas():
    """
    Import RAGAS components.
    Target API (ragas >= 0.2):
      from ragas import evaluate
      from ragas.metrics import context_precision, context_recall,
                                faithfulness, answer_relevancy
    """
    try:
        from ragas import evaluate  # noqa: PLC0415
        from ragas.metrics import (  # noqa: PLC0415
            answer_relevancy,
            context_precision,
            context_recall,
            faithfulness,
        )
        return evaluate, context_precision, context_recall, faithfulness, answer_relevancy
    except ImportError as exc:
        print(
            f"ERROR: ragas not installed ({exc}).\n"
            "  Run: uv venv --python 3.13 && uv pip install -e .\n",
            file=sys.stderr,
        )
        sys.exit(1)


def _import_deepeval():
    """
    Import DeepEval components.
    Target API (deepeval >= 1.4):
      from deepeval.metrics import ContextualPrecisionMetric,
                                   ContextualRecallMetric,
                                   FaithfulnessMetric,
                                   AnswerRelevancyMetric
      from deepeval.test_case import LLMTestCase
      from deepeval import evaluate as deepeval_evaluate
    """
    try:
        from deepeval import evaluate as deepeval_evaluate  # noqa: PLC0415
        from deepeval.metrics import (  # noqa: PLC0415
            AnswerRelevancyMetric,
            ContextualPrecisionMetric,
            ContextualRecallMetric,
            FaithfulnessMetric,
        )
        from deepeval.test_case import LLMTestCase  # noqa: PLC0415
        return (
            deepeval_evaluate,
            ContextualPrecisionMetric,
            ContextualRecallMetric,
            FaithfulnessMetric,
            AnswerRelevancyMetric,
            LLMTestCase,
        )
    except ImportError as exc:
        print(
            f"ERROR: deepeval not installed ({exc}).\n"
            "  Run: uv venv --python 3.13 && uv pip install -e .\n",
            file=sys.stderr,
        )
        sys.exit(1)


def _import_langchain():
    """
    Import LangChain OpenAI wrappers used by RAGAS.
    Target API (langchain-openai >= 0.2):
      from langchain_openai import ChatOpenAI, OpenAIEmbeddings
    Both accept openai_api_base + openai_api_key constructor args.
    """
    try:
        from langchain_openai import ChatOpenAI, OpenAIEmbeddings  # noqa: PLC0415
        return ChatOpenAI, OpenAIEmbeddings
    except ImportError as exc:
        print(
            f"ERROR: langchain-openai not installed ({exc}).\n"
            "  Run: uv venv --python 3.13 && uv pip install -e .\n",
            file=sys.stderr,
        )
        sys.exit(1)


def _import_datasets():
    """
    Import HuggingFace datasets for RAGAS Dataset construction.
    Target API: from datasets import Dataset
    """
    try:
        from datasets import Dataset  # noqa: PLC0415
        return Dataset
    except ImportError as exc:
        print(
            f"ERROR: datasets not installed ({exc}).\n"
            "  Run: uv venv --python 3.13 && uv pip install -e .\n",
            file=sys.stderr,
        )
        sys.exit(1)


# ---------------------------------------------------------------------------
# Dataset loading
# ---------------------------------------------------------------------------

def load_dataset(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"Dataset not found: {path}")
    records = []
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Bad JSON on line {lineno} of {path}: {exc}") from exc
        for key in ("id", "question", "contexts", "answer", "ground_truth"):
            if key not in rec:
                raise SystemExit(f"Record on line {lineno} missing required key '{key}'")
        if not isinstance(rec["contexts"], list):
            raise SystemExit(f"'contexts' on line {lineno} must be a JSON array")
        records.append(rec)
    if not records:
        raise SystemExit(f"Dataset is empty: {path}")
    return records


# ---------------------------------------------------------------------------
# RAGAS scoring
# ---------------------------------------------------------------------------

def run_ragas(records: list[dict], api_key: str) -> dict[str, float]:
    """
    Run RAGAS evaluation over the dataset.

    RAGAS >= 0.2 Dataset columns expected:
      - "question"      : str
      - "contexts"      : List[str]
      - "answer"        : str   (some versions call this "response" — see comment)
      - "ground_truth"  : str   (some versions call this "reference")

    Judge LLM and embeddings are passed via ChatOpenAI / OpenAIEmbeddings
    pointing at the Vercel AI Gateway (OpenAI-compatible endpoint).

    VERSION NOTE: RAGAS >= 0.2 changed column names in some releases:
      "answer" → "response"  and  "ground_truth" → "reference"
    If you see a KeyError on evaluation, swap the column names below.
    """
    print("\n[RAGAS] Building LangChain judge + embeddings wrappers ...", flush=True)
    (
        ragas_evaluate,
        context_precision,
        context_recall,
        faithfulness,
        answer_relevancy,
    ) = _import_ragas()
    ChatOpenAI, OpenAIEmbeddings = _import_langchain()
    Dataset = _import_datasets()

    # RAGAS >= 0.2: pass llm/embeddings directly to evaluate()
    # LangChain wrappers accept openai_api_base + openai_api_key
    judge_llm = ChatOpenAI(
        model=JUDGE_MODEL,
        openai_api_base=GATEWAY_BASE_URL,
        openai_api_key=api_key,
    )
    judge_embeddings = OpenAIEmbeddings(
        model=EMBED_MODEL,
        openai_api_base=GATEWAY_BASE_URL,
        openai_api_key=api_key,
    )

    # Build HuggingFace Dataset with the RAGAS-expected columns
    # If RAGAS version wants "response"/"reference" swap "answer"/"ground_truth" here
    hf_dataset = Dataset.from_list(
        [
            {
                "question": r["question"],
                "contexts": r["contexts"],
                "answer": r["answer"],        # some RAGAS versions: "response"
                "ground_truth": r["ground_truth"],  # some RAGAS versions: "reference"
            }
            for r in records
        ]
    )

    print(f"[RAGAS] Evaluating {len(records)} records with judge={JUDGE_MODEL} ...", flush=True)
    t0 = time.time()
    result = ragas_evaluate(
        dataset=hf_dataset,
        metrics=[context_precision, context_recall, faithfulness, answer_relevancy],
        llm=judge_llm,
        embeddings=judge_embeddings,
    )
    elapsed = time.time() - t0
    print(f"[RAGAS] Done in {elapsed:.1f}s", flush=True)

    # result is a ragas.result.EvaluationResult; .to_pandas() gives per-row scores
    # Aggregate: mean per metric across all records
    scores: dict[str, float] = {}
    try:
        # EvaluationResult.__getitem__ / .scores dict (ragas >= 0.2)
        # Each metric name is the string key; value is a float mean
        df = result.to_pandas()
        metric_cols = {
            "context_precision": "context_precision",
            "context_recall": "context_recall",
            "faithfulness": "faithfulness",
            "answer_relevancy": "answer_relevancy",
        }
        for out_name, col in metric_cols.items():
            if col in df.columns:
                scores[out_name] = float(df[col].mean())
            else:
                # Fallback: try result[col] dict-access (older RAGAS)
                scores[out_name] = float(result[col])
    except Exception as exc:
        print(f"[RAGAS] WARNING: could not parse result dict ({exc}); raw = {result}", file=sys.stderr)
        # Last-resort: try treating result as a dict
        try:
            for k in ("context_precision", "context_recall", "faithfulness", "answer_relevancy"):
                scores[k] = float(dict(result).get(k, float("nan")))
        except Exception:
            pass

    return scores


# ---------------------------------------------------------------------------
# DeepEval scoring
# ---------------------------------------------------------------------------

def run_deepeval(records: list[dict], api_key: str) -> dict[str, float]:
    """
    Run DeepEval evaluation over the dataset.

    DeepEval >= 1.4 is configured via environment variables for its OpenAI
    client (the library reads OPENAI_BASE_URL + OPENAI_API_KEY at import time
    for its default model, but individual metric instances also accept a `model`
    arg).  We set both before importing deepeval so the judge is routed through
    the Vercel AI Gateway.

    LLMTestCase fields used:
      input             = question
      actual_output     = answer
      expected_output   = ground_truth
      retrieval_context = contexts (List[str])
    """
    # Configure judge BEFORE deepeval imports read os.environ
    os.environ.setdefault("OPENAI_API_KEY", api_key)
    os.environ.setdefault("OPENAI_BASE_URL", GATEWAY_BASE_URL)
    # DeepEval also respects DEEPEVAL_OPENAI_MODEL for its internal judge
    os.environ.setdefault("DEEPEVAL_OPENAI_MODEL", JUDGE_MODEL)

    print("\n[DeepEval] Importing and configuring metrics ...", flush=True)
    (
        deepeval_evaluate,
        ContextualPrecisionMetric,
        ContextualRecallMetric,
        FaithfulnessMetric,
        AnswerRelevancyMetric,
        LLMTestCase,
    ) = _import_deepeval()

    # Instantiate metrics — model arg overrides the env var for safety
    # DeepEval >= 1.4: metrics accept `model` str (OpenAI model name / slug)
    metric_kwargs: dict = {"model": JUDGE_MODEL, "include_reason": False}
    metrics = [
        ContextualPrecisionMetric(**metric_kwargs),
        ContextualRecallMetric(**metric_kwargs),
        FaithfulnessMetric(**metric_kwargs),
        AnswerRelevancyMetric(**metric_kwargs),
    ]

    test_cases = [
        LLMTestCase(
            input=r["question"],
            actual_output=r["answer"],
            expected_output=r["ground_truth"],
            retrieval_context=r["contexts"],
        )
        for r in records
    ]

    print(
        f"[DeepEval] Evaluating {len(test_cases)} test cases with judge={JUDGE_MODEL} ...",
        flush=True,
    )
    t0 = time.time()
    # deepeval.evaluate returns an EvaluationResult with .test_results list
    eval_result = deepeval_evaluate(test_cases=test_cases, metrics=metrics, run_async=False)
    elapsed = time.time() - t0
    print(f"[DeepEval] Done in {elapsed:.1f}s", flush=True)

    # Aggregate per-metric scores from test_results
    # Each test_result.metrics_metadata is a list of MetricMetadata(name, score, ...)
    metric_name_map = {
        "Contextual Precision": "context_precision",
        "Contextual Recall": "context_recall",
        "Faithfulness": "faithfulness",
        "Answer Relevancy": "answer_relevancy",
    }
    sums: dict[str, list[float]] = {v: [] for v in metric_name_map.values()}

    for tr in eval_result.test_results:
        for mm in tr.metrics_metadata:
            canonical = metric_name_map.get(mm.metric)
            if canonical and mm.score is not None:
                sums[canonical].append(float(mm.score))

    scores: dict[str, float] = {}
    for canonical, vals in sums.items():
        scores[canonical] = sum(vals) / len(vals) if vals else float("nan")

    return scores


# ---------------------------------------------------------------------------
# --gen-context mode: regenerate contexts + answers from the live bundle
# ---------------------------------------------------------------------------

def gen_context_from_bundle(records: list[dict], api_key: str) -> list[dict]:
    """
    For each record, invoke the oxagen CLI bundle in --readonly --verbose mode
    and extract the model's answer (replaces 'answer' in the record).
    Contexts are NOT replaced — the bundle doesn't expose raw retrieved chunks
    over stdout; only the final answer is captured.

    This is a best-effort mode. If the bundle is unavailable, original records
    are returned unchanged.
    """
    if not Path(BUNDLE).exists():
        print(
            f"[gen-context] Bundle not found at {BUNDLE}.\n"
            "  Run: pnpm --filter @oxagen/cli bundle\n"
            "  Falling back to static dataset.",
            file=sys.stderr,
        )
        return records

    env = {**os.environ, "AI_GATEWAY_API_KEY": api_key}
    updated = []
    for rec in records:
        print(f"  [gen-context] Running bundle for: {rec['id']} ...", flush=True)
        cmd = [
            "node", BUNDLE, rec["question"],
            "--readonly", "--model", os.environ.get("OXAGEN_MODEL_SLUG", "anthropic/claude-sonnet-4.5"),
            "--verbose",
        ]
        t0 = time.time()
        try:
            p = subprocess.run(
                cmd, cwd=str(REPO), env=env,
                capture_output=True, text=True, timeout=TIMEOUT,
            )
            answer = p.stdout.strip() or p.stderr.strip()
        except subprocess.TimeoutExpired:
            answer = rec["answer"]
            print(f"  [gen-context] TIMEOUT for {rec['id']}", file=sys.stderr)
        elapsed = time.time() - t0
        print(f"  [gen-context] {rec['id']} in {elapsed:.1f}s", flush=True)
        updated.append({**rec, "answer": answer})

    return updated


# ---------------------------------------------------------------------------
# Summary printing
# ---------------------------------------------------------------------------

METRIC_LABELS = [
    ("context_precision",  "contextPrecision"),
    ("context_recall",     "contextRecall"),
    ("faithfulness",       "(faithfulness)"),
    ("answer_relevancy",   "(answerRelevancy)"),
]

ENGRAM_MAP = {
    "context_precision": "engram contextPrecision",
    "context_recall": "engram contextRecall",
    "faithfulness": "(no direct engram equivalent — faithfulness cross-check)",
    "answer_relevancy": "(no direct engram equivalent — relevancy cross-check)",
}


def print_summary(ragas_scores: dict[str, float], de_scores: dict[str, float]) -> None:
    print("\n\n" + "=" * 70)
    print("  RAG EVAL SUMMARY  (Vercel AI Gateway judge: " + JUDGE_MODEL + ")")
    print("=" * 70)
    print(f"\n{'Metric':<24}{'RAGAS':>10}{'DeepEval':>12}{'Engram field'}")
    print("-" * 70)
    for metric, engram_name in METRIC_LABELS:
        r = ragas_scores.get(metric, float("nan"))
        d = de_scores.get(metric, float("nan"))
        r_str = f"{r:.4f}" if r == r else "  N/A"  # NaN check
        d_str = f"{d:.4f}" if d == d else "    N/A"
        print(f"{metric:<24}{r_str:>10}{d_str:>12}  {engram_name}")
    print("-" * 70)
    print()
    print("Metric mapping (RAGAS ↔ engram EvalMetrics):")
    print("  RAGAS context_precision  ↔  engram contextPrecision")
    print("  RAGAS context_recall     ↔  engram contextRecall")
    print("  RAGAS faithfulness       ↔  (no direct equivalent — cross-check)")
    print("  RAGAS answer_relevancy   ↔  (no direct equivalent — cross-check)")
    print()
    print(f"Full results written to: {OUT}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="RAG-quality eval for Oxagen's context engine (RAGAS + DeepEval).",
    )
    parser.add_argument(
        "--dataset",
        default=os.environ.get("RAG_DATASET", str(DEFAULT_DATASET)),
        help="Path to dataset.jsonl (default: bench/rag-eval/dataset.jsonl or $RAG_DATASET)",
    )
    parser.add_argument(
        "--gen-context",
        action="store_true",
        help=(
            "Regenerate each record's 'answer' field by querying the live oxagen bundle "
            "before scoring. Requires built bundle at apps/cli/dist-standalone/oxagen.mjs."
        ),
    )
    parser.add_argument(
        "--ragas-only",
        action="store_true",
        help="Run RAGAS only, skip DeepEval.",
    )
    parser.add_argument(
        "--deepeval-only",
        action="store_true",
        help="Run DeepEval only, skip RAGAS.",
    )
    args = parser.parse_args()

    api_key = gw_key()
    records = load_dataset(Path(args.dataset))
    print(f"Loaded {len(records)} records from {args.dataset}")

    if args.gen_context:
        print("\n[gen-context] Generating answers from live oxagen bundle ...")
        records = gen_context_from_bundle(records, api_key)

    ragas_scores: dict[str, float] = {}
    de_scores: dict[str, float] = {}

    if not args.deepeval_only:
        ragas_scores = run_ragas(records, api_key)

    if not args.ragas_only:
        de_scores = run_deepeval(records, api_key)

    print_summary(ragas_scores, de_scores)

    OUT.write_text(
        json.dumps(
            {
                "dataset": str(args.dataset),
                "judge_model": JUDGE_MODEL,
                "embed_model": EMBED_MODEL,
                "n_records": len(records),
                "ragas": ragas_scores,
                "deepeval": de_scores,
                "engram_map": ENGRAM_MAP,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
