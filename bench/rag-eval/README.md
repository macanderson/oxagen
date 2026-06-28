# RAG Eval — RAGAS + DeepEval context/retrieval quality suite

Scores the **quality of context retrieval** in Oxagen's context engine using
two industry-standard LLM-as-judge frameworks — [RAGAS](https://docs.ragas.io)
and [DeepEval](https://docs.confident-ai.com) — with the **Vercel AI Gateway**
as the judge LLM.

This is the **external cross-validation** of Oxagen's homegrown context metrics
(`contextPrecision` / `contextRecall`) defined in
`packages/engram/src/eval/metrics.ts`. Running both the engram TS metrics and
this RAGAS/DeepEval suite on the same dataset gives a side-by-side comparison
that guards against metric-implementation drift.

Contrast with `bench/context-eval/` (the sibling eval): that suite measures
**end-to-end accuracy + cost** of the context engine against a cold Claude Code
baseline; this suite measures **retrieval quality in isolation** — are the right
chunks being packed into context?

---

## What it measures

| RAGAS metric | DeepEval metric | Engram `EvalMetrics` field |
|---|---|---|
| `context_precision` | `ContextualPrecisionMetric` | `contextPrecision` |
| `context_recall` | `ContextualRecallMetric` | `contextRecall` |
| `faithfulness` | `FaithfulnessMetric` | *(no direct equivalent — faithfulness cross-check)* |
| `answer_relevancy` | `AnswerRelevancyMetric` | *(no direct equivalent — relevancy cross-check)* |

- **context_precision** — of the chunks that were packed into context, what
  fraction were actually relevant to the question? (`contextPrecision` in engram)
- **context_recall** — of all the information the correct answer requires, what
  fraction was present in the retrieved context? (`contextRecall` in engram)
- **faithfulness** — is the model's answer grounded in (supported by) the
  provided context? (guards hallucination)
- **answer_relevancy** — is the answer on-topic for the question asked?

---

## Axis-B placement

This eval sits on the **quality axis** (Axis B) of Oxagen's eval pyramid:

```
Axis A — End-to-end accuracy + cost  (bench/context-eval/)
Axis B — Retrieval quality            (bench/rag-eval/)   ← YOU ARE HERE
Axis C — Live E2E user flows          (apps/app/e2e/)
```

---

## Dataset schema

`dataset.jsonl` — one JSON object per line:

```jsonc
{
  "id":           "unique-slug",
  "question":     "The question posed to the retrieval system",
  "contexts":     ["<retrieved code snippet 1>", "<snippet 2>", ...],
  "answer":       "The answer the agent produced given those contexts",
  "ground_truth": "The canonical correct answer"
}
```

The seed dataset (`dataset.jsonl`) contains 6 records derived from the same
repo-structural questions as `bench/context-eval/run_eval.py`.  One record
(`codegraph-builder`) intentionally has an **incomplete/noisy `contexts`
array** (the needed import line is absent) so that `context_recall` is
meaningfully < 1.0 and the metric exercises a non-trivial path.

### Round-trip cross-validation

The engram TS harness can export a `dataset.jsonl` in exactly this schema.
Pass it to the runner for cross-validation:

```bash
RAG_DATASET=/path/to/engram-export.jsonl python bench/rag-eval/run_rag_eval.py
# or
python bench/rag-eval/run_rag_eval.py --dataset /path/to/engram-export.jsonl
```

See `packages/engram/src/eval/` for the TS-side harness.  
See `docs/cli/eval-runbook.md` for the full evaluation runbook.

---

## Install

```bash
cd bench/rag-eval
uv venv --python 3.13
source .venv/bin/activate
uv pip install -e .
```

---

## Run

```bash
# Set the judge key (or put it in repo .env.local as AI_GATEWAY_API_KEY=...)
export AI_GATEWAY_API_KEY=<your-vercel-ai-gateway-key>

# Score the seed dataset (no external deps beyond the key)
python bench/rag-eval/run_rag_eval.py

# Score a custom dataset exported from the engram TS harness
python bench/rag-eval/run_rag_eval.py --dataset /path/to/export.jsonl

# Run RAGAS only (skip DeepEval)
python bench/rag-eval/run_rag_eval.py --ragas-only

# Run DeepEval only (skip RAGAS)
python bench/rag-eval/run_rag_eval.py --deepeval-only

# Regenerate answers from the live oxagen bundle, then score
pnpm --filter @oxagen/cli bundle
python bench/rag-eval/run_rag_eval.py --gen-context
```

Results are written to `bench/rag-eval/results.json` (git-ignored).

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `AI_GATEWAY_API_KEY` | *(required)* | Vercel AI Gateway key — read from env or repo `.env.local` |
| `RAG_JUDGE_MODEL` | `openai/gpt-4o-mini` | Judge LLM slug (must be available on the gateway) |
| `RAG_EMBED_MODEL` | `openai/text-embedding-3-small` | Embeddings model slug (RAGAS only) |
| `RAG_DATASET` | `bench/rag-eval/dataset.jsonl` | Path to the dataset to score |
| `EVAL_TIMEOUT` | `300` | Per-question timeout in seconds (--gen-context mode) |
| `OXAGEN_MODEL_SLUG` | `anthropic/claude-sonnet-4.5` | Model slug used in --gen-context bundle calls |

---

## Judge LLM — Vercel AI Gateway

Both RAGAS and DeepEval are configured to use the Vercel AI Gateway at
`https://ai-gateway.vercel.sh/v1` (OpenAI-compatible endpoint):

- **RAGAS**: via `langchain_openai.ChatOpenAI` + `OpenAIEmbeddings` with
  `openai_api_base=https://ai-gateway.vercel.sh/v1` — passed directly to
  `ragas.evaluate(llm=..., embeddings=...)`.
- **DeepEval**: via env vars `OPENAI_BASE_URL` + `OPENAI_API_KEY` + 
  `DEEPEVAL_OPENAI_MODEL` (set before import so deepeval's internal client
  picks them up), plus per-metric `model=` arg.

Change the judge with `RAG_JUDGE_MODEL=openai/gpt-4o`.

---

## Related

- `bench/context-eval/` — end-to-end accuracy + cost eval (same questions)
- `packages/engram/src/eval/metrics.ts` — engram `EvalMetrics` interface
- `packages/engram/src/eval/` — TS-side eval harness
- `docs/cli/eval-runbook.md` — full evaluation runbook

---

## Emit + ingest to ClickHouse

Running the harness automatically writes a normalized `rag-eval.eval.json`
(a single `oxagen.eval.v1` object with aggregate RAGAS/DeepEval scores) in the
same directory as `run_rag_eval.py`.  Override the path with the `RAG_EVAL_JSON`
env var.  Pass `--no-emit-json` to suppress the file entirely.

To load the file into ClickHouse:

```bash
pnpm eval:ingest bench/rag-eval/rag-eval.eval.json
# short alias:
pnpm eval bench/rag-eval/rag-eval.eval.json
```

See `docs/cli/eval-results-schema.md` for the full `oxagen.eval.v1` schema.
