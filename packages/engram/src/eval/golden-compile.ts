/**
 * Deterministic golden compiler — a real (if simple) context compiler used to
 * drive the eval harness over {@link GOLDEN_CORPUS} without DuckDB, embeddings, an
 * LLM, or the network. It is a lexical retriever + budget packer: score each record
 * by query-term overlap, drop zero-overlap noise, then greedily pack the survivors
 * under the turn's token budget. This is what makes `runEvalSuite` a runnable CI
 * gate rather than infrastructure — see golden-suite.test.ts.
 *
 * It mirrors the real CLI fleet-memory recall scorer (term overlap, stopword-aware)
 * closely enough to exercise the harness's precision/recall/hit-rate math on real
 * data, while staying fully deterministic.
 */
import type { MemoryRecord } from "../types";
import type { TaskFrame } from "../retrieval/types";
import type { TokenBudget } from "../compiler/packer";
import { countTokens } from "../compiler/tokenizer";

/** Articles, prepositions, and generic question words that carry no retrieval signal. */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "from",
  "with",
  "that",
  "this",
  "what",
  "which",
  "does",
  "where",
  "who",
  "whom",
  "into",
  "onto",
  "are",
  "was",
  "were",
  "has",
  "have",
  "its",
  "value",
  "constant",
  "module",
  "file",
  "mention",
  "answer",
  "just",
  "name",
  "give",
  "list",
  "used",
  "use",
  "uses",
  "set",
  "their",
  "you",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and 1–2 char tokens. */
function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

function factText(record: MemoryRecord): string {
  const body = record.body as { fact?: string; domain?: string };
  return `${body.fact ?? ""} ${body.domain ?? ""}`.trim();
}

export interface CompiledRecord {
  id: string;
  score: number;
  text: string;
  tokens: number;
}

/**
 * Score + rank the corpus for a task frame (exposed for the dataset export so the
 * RAGAS/DeepEval bridge sees exactly the contexts the harness scored).
 */
export function rankCorpus(
  corpus: MemoryRecord[],
  taskFrame: TaskFrame,
): CompiledRecord[] {
  const query = terms(
    `${taskFrame.taskDescription} ${taskFrame.workingSet.join(" ")}`,
  );
  return corpus
    .map((record): CompiledRecord => {
      const text = factText(record);
      let score = 0;
      for (const term of terms(text)) if (query.has(term)) score++;
      return {
        id: record.id,
        score,
        text,
        tokens: countTokens(text, taskFrame.modelId),
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * Build a `compileFn` for {@link runEvalSuite}: returns the ids packed into the
 * volatile slice of the budget, highest-overlap first.
 */
export function makeGoldenCompileFn(
  corpus: MemoryRecord[],
): (taskFrame: TaskFrame, budget: TokenBudget) => Promise<string[]> {
  return async function compileGolden(taskFrame, budget): Promise<string[]> {
    const ranked = rankCorpus(corpus, taskFrame);
    const cap = budget.reserved.volatile;
    const packed: string[] = [];
    let used = 0;
    for (const candidate of ranked) {
      if (used + candidate.tokens > cap) continue;
      packed.push(candidate.id);
      used += candidate.tokens;
    }
    return packed;
  };
}
