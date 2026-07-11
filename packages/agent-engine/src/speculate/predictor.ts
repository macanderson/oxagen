/**
 * Deterministic next-read predictor for speculative tool execution (ADR-030).
 *
 * Pure heuristics over ONE tool observation (the call that just returned and
 * its result string) — no model, no filesystem, no state. Exposed behind the
 * {@link SpeculationPredictor} port so a local draft model can replace the
 * heuristics later without touching the speculation layer.
 *
 * Every heuristic mirrors a follow-up the model is overwhelmingly likely to
 * make because the result itself steers it there:
 *
 * - An over-cap `read_file` result embeds its own follow-up in the truncation
 *   marker ("call read_file with offset:N, limit:M") — tools.ts wrote that
 *   marker precisely so the model would issue that call; predicting it is
 *   near-certain.
 * - A `grep` hit list is followed by reads of the top distinct matching files.
 * - A `glob` listing is followed by reads of its first entries.
 */

/** One completed tool call: what ran, with what input, and the string result. */
export interface ToolObservation {
  tool: string;
  input: unknown;
  result: string;
}

/** A call the predictor expects the model to make next. */
export interface PredictedCall {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * The predictor port: observation in, likely next calls out (most confident
 * first). Implementations must be pure and fast — the layer calls this on the
 * hot path after every read.
 */
export type SpeculationPredictor = (
  observation: ToolObservation,
) => PredictedCall[];

/** Most predictions a single observation may contribute. */
export const MAX_PREDICTIONS_PER_OBSERVATION = 3;

/** Matches the read_file truncation marker's embedded follow-up call. */
const TRUNCATION_FOLLOW_UP_RE =
  /call read_file with offset:(\d+),\s*limit:(\d+)/;

/** Matches a `path:line:` grep hit prefix (path must look file-ish). */
const GREP_HIT_RE = /^([^\s:][^:]*):(\d+):/;

function isPathLike(line: string): boolean {
  return (
    line.length > 0 &&
    !line.startsWith("(") && // "(no matches)"
    !line.startsWith("…") && // clip() truncation marker
    !line.includes("\0")
  );
}

export const heuristicPredictor: SpeculationPredictor = ({
  tool,
  input,
  result,
}) => {
  const predictions: PredictedCall[] = [];

  if (tool === "read_file") {
    const followUp = TRUNCATION_FOLLOW_UP_RE.exec(result);
    const path = (input as { path?: unknown } | null)?.path;
    if (followUp && typeof path === "string") {
      predictions.push({
        tool: "read_file",
        input: {
          path,
          offset: Number(followUp[1]),
          limit: Number(followUp[2]),
        },
      });
    }
    return predictions;
  }

  if (tool === "grep") {
    const seen = new Set<string>();
    for (const line of result.split("\n")) {
      const hit = GREP_HIT_RE.exec(line);
      if (!hit) continue;
      const path = hit[1]!;
      if (seen.has(path)) continue;
      seen.add(path);
      predictions.push({ tool: "read_file", input: { path } });
      if (predictions.length >= MAX_PREDICTIONS_PER_OBSERVATION) break;
    }
    return predictions;
  }

  if (tool === "glob") {
    for (const line of result.split("\n")) {
      if (!isPathLike(line)) continue;
      predictions.push({ tool: "read_file", input: { path: line } });
      if (predictions.length >= 2) break; // listings are broader — stay modest
    }
    return predictions;
  }

  return predictions;
};
