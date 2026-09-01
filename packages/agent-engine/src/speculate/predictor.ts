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
 * - A `search` result is followed by reads of the top distinct matching
 *   files — content hits first, then a couple of name-only matches.
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

/** A bare relative path on its own line — `search`'s "matching by name" body. */
function isBarePathLine(line: string): boolean {
  return (
    isPathLike(line) &&
    !line.includes(" ") && // headers ("Files matching by name:") have spaces
    !line.endsWith(":") && // section header line
    (line.includes("/") || line.includes("."))
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

  if (tool === "search") {
    // The unified search returns a "Files matching by name:" section of bare
    // paths and a "Content matches:" section of `path:line:text`. TWO passes,
    // not one line-order pass: names are printed first but content hits carry
    // line-level evidence the model is likelier to open, so content must win
    // the budget regardless of print order.
    //
    // Name lines use `isBarePathLine`, not `isPathLike` — the latter admits
    // the section headers themselves ("Files matching by name:" has no
    // leading paren and no NUL), which would spend read_file prefetches on
    // strings that are not paths at all.
    const lines = result.split("\n");
    const seen = new Set<string>();
    for (const line of lines) {
      const hit = GREP_HIT_RE.exec(line);
      if (!hit) continue;
      const path = hit[1]!;
      if (seen.has(path)) continue;
      seen.add(path);
      predictions.push({ tool: "read_file", input: { path } });
      if (predictions.length >= MAX_PREDICTIONS_PER_OBSERVATION) {
        return predictions;
      }
    }
    let nameReads = 0;
    for (const line of lines) {
      if (nameReads >= 2) break; // listings are broader — stay modest
      if (!isBarePathLine(line) || seen.has(line)) continue;
      seen.add(line);
      nameReads += 1;
      predictions.push({ tool: "read_file", input: { path: line } });
      if (predictions.length >= MAX_PREDICTIONS_PER_OBSERVATION) {
        return predictions;
      }
    }
    return predictions;
  }

  return predictions;
};
