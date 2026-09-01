/**
 * Speculative tool execution — the cache layer (ADR-030).
 *
 * Wraps a ToolSet so that after every real read-tool result, a predictor
 * proposes the likely next calls and the layer executes them EARLY into a
 * promise cache. When the model then issues a matching call, it awaits the
 * same promise — hit or still-in-flight, the filesystem work happens once and
 * the model-visible latency collapses to (at worst) the remaining in-flight
 * time.
 *
 * Safety is structural, not behavioral:
 *
 * - Only the hard-coded read-only allowlist ({@link SPECULATABLE_TOOLS}) is
 *   ever speculated or served from cache.
 * - EVERY other tool call — write_file, edit_file, bash, structured runners,
 *   MCP extras, anything — invalidates the whole cache, both when it starts
 *   and when it settles, because it may have changed anything on disk. While
 *   one is in flight, speculation is suspended, so a read racing a mutation
 *   can never pin a half-mutated result. Known-pure interactive/query tools
 *   ({@link PURE_TOOLS}) are exempt from invalidating but still never cached.
 * - Tool results are strings by contract (errors included, tools never
 *   throw — see withBackstop in tools.ts), so a speculated failure serves
 *   exactly what a live call would have returned.
 * - The cache lives and dies with the wrapped ToolSet: one agent turn, no
 *   cross-turn staleness.
 */
import type { ToolSet } from "ai";
import {
  heuristicPredictor,
  MAX_PREDICTIONS_PER_OBSERVATION,
  type SpeculationPredictor,
} from "./predictor";

/** Read-only tools the layer may speculate and serve from cache. */
export const SPECULATABLE_TOOLS = new Set([
  "read_file",
  "search",
  "list_dir",
  // code_graph reads the code-graph index, not the live filesystem, so it is
  // cache-safe under the same conservative rule as the reads above (any
  // mutation drops the whole cache; the index itself only re-syncs between
  // turns). Prefetch discipline lives in the predictor: only deterministic
  // operations are ever PREDICTED — `semantic_search` is never speculated
  // (each prefetch would spend an embedding on a prediction that may never be
  // consumed) — though a repeated identical model-issued call of any
  // operation may still be served from cache.
  "code_graph",
]);

/** Known-pure tools that neither mutate the filesystem nor get speculated. */
const PURE_TOOLS = new Set(["ask_user"]);

export interface SpeculationStats {
  /** Speculative executions launched. */
  predicted: number;
  /** Real calls served from the cache (resolved or in-flight). */
  hits: number;
  /** Real speculatable calls that found no cache entry. */
  misses: number;
  /** Cached entries discarded unconsumed (by invalidation or turn end). */
  wasted: number;
  /** Whole-cache invalidations triggered by non-allowlisted tool calls. */
  invalidations: number;
}

export interface SpeculativeToolsOptions {
  /** Next-call predictor (default: {@link heuristicPredictor}). */
  predictor?: SpeculationPredictor;
  /** Max speculative executions in flight at once (default 2). */
  maxConcurrent?: number;
  /** Max cached entries; further predictions are dropped (default 24). */
  maxCacheEntries?: number;
  /** Observer invoked with a stats snapshot after every cache event. */
  onStats?: (stats: Readonly<SpeculationStats>) => void;
}

type ToolExecute = (input: unknown, options: unknown) => PromiseLike<unknown>;

/**
 * Canonical cache key: tool name + JSON with sorted keys and undefined values
 * dropped, so `{path, offset: undefined}` and `{path}` collide as intended.
 */
export function speculationKey(tool: string, input: unknown): string {
  return `${tool} ${canonicalJson(input)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Wrap `tools` with the speculation layer. Call AFTER extraTools are merged
 * (so mutating MCP tools invalidate too) and BEFORE the caller's outer
 * wrapTools (permission gate / hooks), which must still see every real call.
 */
export function wrapToolsWithSpeculation(
  tools: ToolSet,
  opts: SpeculativeToolsOptions = {},
): ToolSet {
  const predictor = opts.predictor ?? heuristicPredictor;
  const maxConcurrent = opts.maxConcurrent ?? 2;
  const maxCacheEntries = opts.maxCacheEntries ?? 24;

  const cache = new Map<string, PromiseLike<unknown>>();
  const stats: SpeculationStats = {
    predicted: 0,
    hits: 0,
    misses: 0,
    wasted: 0,
    invalidations: 0,
  };
  let speculationsInFlight = 0;
  let mutationsInFlight = 0;

  const emit = (): void => opts.onStats?.({ ...stats });

  const invalidate = (): void => {
    if (cache.size > 0) stats.wasted += cache.size;
    cache.clear();
    stats.invalidations++;
    emit();
  };

  const speculate = (
    name: string,
    input: Record<string, unknown>,
    execute: ToolExecute,
  ): void => {
    if (mutationsInFlight > 0) return; // a racing read could pin mutated state
    if (speculationsInFlight >= maxConcurrent) return;
    if (cache.size >= maxCacheEntries) return;
    const key = speculationKey(name, input);
    if (cache.has(key)) return;
    stats.predicted++;
    speculationsInFlight++;
    const run = Promise.resolve()
      .then(() => execute(input, {}))
      // Tools resolve error STRINGS rather than throwing; a throw here would
      // be a wrapper bug — surface it in-band exactly like the tools do.
      .catch(
        (err: unknown) =>
          `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    void run.then(() => {
      speculationsInFlight--;
    });
    cache.set(key, run);
    emit();
  };

  // Raw (unwrapped) executes, so speculative executions never re-enter the
  // wrapper — a speculation must not count as a miss or predict recursively.
  const rawExecs = new Map<string, ToolExecute>();
  for (const [name, toolDef] of Object.entries(tools)) {
    if (SPECULATABLE_TOOLS.has(name) && toolDef.execute) {
      rawExecs.set(name, toolDef.execute as ToolExecute);
    }
  }

  const out: ToolSet = {};
  for (const [name, toolDef] of Object.entries(tools)) {
    const exec = toolDef.execute as ToolExecute | undefined;
    if (!exec) {
      out[name] = toolDef;
      continue;
    }

    if (SPECULATABLE_TOOLS.has(name)) {
      out[name] = {
        ...toolDef,
        execute: async (input: unknown, options: unknown) => {
          const key = speculationKey(name, input);
          const cached = cache.get(key);
          let result: unknown;
          if (cached) {
            stats.hits++;
            cache.delete(key); // consumed — a re-read must see fresh content
            result = await cached;
          } else {
            stats.misses++;
            result = await exec(input, options);
          }
          emit();
          // Feed the observation forward: launch the predicted next reads
          // against the RAW executes so the work is cached for the model's
          // actual follow-up call.
          for (const p of predictor({
            tool: name,
            input,
            result: String(result),
          }).slice(0, MAX_PREDICTIONS_PER_OBSERVATION)) {
            const targetExec = rawExecs.get(p.tool);
            if (!targetExec) continue;
            speculate(p.tool, p.input, targetExec);
          }
          return result;
        },
      };
      continue;
    }

    if (PURE_TOOLS.has(name)) {
      out[name] = toolDef;
      continue;
    }

    // Everything else may mutate the filesystem (bash, write_file, edit_file,
    // structured runners, MCP extras): fence speculation for its duration and
    // drop the cache on both edges.
    out[name] = {
      ...toolDef,
      execute: async (input: unknown, options: unknown) => {
        mutationsInFlight++;
        invalidate();
        try {
          return await exec(input, options);
        } finally {
          mutationsInFlight--;
          invalidate();
        }
      },
    };
  }
  return out;
}
