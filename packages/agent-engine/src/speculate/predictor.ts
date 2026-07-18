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

/** Most read_file predictions mined from one code_graph result — stay modest. */
const MAX_CODE_GRAPH_READS = 2;

/** Matches a CLI code-graph row: "kind name — path:line" (signature tail ok). */
const CODE_GRAPH_EMDASH_RE = /—\s+([^\s:]+):\d+/;

/** Matches a CLI semantic-search row: "path (0.87)". */
const CODE_GRAPH_SCORED_RE = /^(\S+)\s+\(\d+(?:\.\d+)?\)$/;

function isPathLike(line: string): boolean {
  return (
    line.length > 0 &&
    !line.startsWith("(") && // "(no matches)"
    !line.startsWith("…") && // clip() truncation marker
    !line.includes("\0")
  );
}

/** A bare relative path on its own line (dependents/imports listing body). */
function isBarePathLine(line: string): boolean {
  return (
    isPathLike(line) &&
    !line.includes(" ") && // headers ("Files importing x (3):") have spaces
    !line.endsWith(":") && // file_symbols header line ("src/a.ts:")
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
    // Impact prefetch: the file just read is the file the model most likely
    // changes next, and the code_graph description steers it to `dependents`
    // for impact analysis before a change. Deterministic operation ONLY —
    // never `semantic_search`, whose prefetch would spend an embedding on a
    // prediction that may never be consumed. Providers without an import
    // graph answer `dependents` with a static pointer string at zero cost,
    // and the layer drops the prediction entirely when no code_graph tool is
    // in the ToolSet, so this is safe to predict unconditionally.
    if (typeof path === "string") {
      predictions.push({
        tool: "code_graph",
        input: { operation: "dependents", query: path },
      });
    }
    return predictions;
  }

  if (tool === "code_graph") {
    // A code-graph answer is a list of code locations; the near-certain
    // follow-up is reading the top hits. Row shapes vary by provider:
    //   platform:  "path:line: kind name"
    //   CLI:       "kind name — path:line (sig)"    (search / file_symbols)
    //              bare path lines under a header   (dependents / imports)
    //              "path (0.87)"                    (semantic_search)
    // Only READS are predicted from here — never further code_graph calls —
    // so no operation (semantic_search included) can cascade speculatively.
    const seen = new Set<string>();
    for (const line of result.split("\n")) {
      const path =
        GREP_HIT_RE.exec(line)?.[1] ??
        CODE_GRAPH_EMDASH_RE.exec(line)?.[1] ??
        CODE_GRAPH_SCORED_RE.exec(line)?.[1] ??
        (isBarePathLine(line) ? line : undefined);
      if (path === undefined || seen.has(path)) continue;
      seen.add(path);
      predictions.push({ tool: "read_file", input: { path } });
      if (predictions.length >= MAX_CODE_GRAPH_READS) break;
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
