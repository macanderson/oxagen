/**
 * findings-result-use.ts — the read behind detector 5's result use
 * (./findings/result-use.ts, decision 7 of the spend plan): whether a later
 * step quoted each large tool result.
 *
 * The text lives only in evidence bodies, which the control plane keeps when
 * the workspace's retention policy is `content_exact` for the body's class.
 * A result and a later call's input share a `tool_call` body, class
 * `tool_call`. What the agent wrote is a `turn_end`, `subagent_stop`, or
 * transcript `llm_call` body, class `model_call`. A result is unused only
 * when neither kind of step quoted it, so a policy that keeps one class and
 * not the other reads as `digest_only` here. A model proxy's `llm_call` body
 * holds the whole request, the result included, so it is not read as text
 * the agent wrote.
 *
 * The read walks the chains that hold a large result, the ones whose results
 * add most tokens first. Each chain's frames from its first large result on
 * are read in one query, and their bodies count against
 * `RESULT_USE_BODIES_MAX`. A chain that would pass what is left of it is
 * skipped, and its results get no verdict, so detector 5 counts them in full.
 *
 * A body is read back, checked against its digest, and decoded as UTF-8. One
 * that fails any of the three for good reads as no text, which leaves the
 * results before it with no verdict. Any other failure fails the read, and
 * with it the pass, so the job retries the workspace.
 *
 * The pass runs outside a tenant scope, so each read that needs one enters
 * it for the workspace it reads.
 */
import { createHash } from "node:crypto";
import { readLatestRetentionPolicy, withSystemDb } from "@oxagen/database";
import { chSelect } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  chainVerdicts,
  microsOf,
  resultUseKey,
  timeOf,
  type ChainFrame,
  type ResultTextMode,
  type ResultUseRead,
  type ResultVerdict,
  type ToolCallObservation,
} from "./findings";
import { logger } from "./logger";

type Scope = { orgId: string; workspaceId: string };

/** Bodies one pass reads to check its large results. */
export const RESULT_USE_BODIES_MAX = 4_000;
/** Frames one chain may hold from its first large result on; a longer chain is not checked. */
export const RESULT_USE_CHAIN_FRAMES_MAX = 1_000;
/** Body reads one pass runs at once. */
const BODY_READ_CONCURRENCY = 8;

/** One frame row as ClickHouse returns it. */
interface StepRow {
  seq: string | number;
  at: string;
  kind: string;
  source: string;
  content_digest: string;
  bytes_ref: string;
}

/**
 * The frames on one chain from `from` on that carry a body digest: tool
 * calls, and the text the agent wrote. A model proxy's `llm_call` is left
 * out, since its body holds the whole request.
 */
export const RESULT_STEPS_QUERY = `SELECT seq,
  formatDateTime(ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS at,
  kind, source, content_digest, bytes_ref
  FROM tacho_events FINAL
  WHERE root_session_uuid = {root:UUID}
    AND session_uuid = {chain:UUID}
    AND ts >= {from:DateTime64(3)}
    AND received_at >= {from:DateTime64(3)} - INTERVAL 1 DAY
    AND content_digest != ''
    AND (kind IN ('tool_call', 'turn_end', 'subagent_stop')
      OR (kind = 'llm_call' AND source = 'transcript'))
  ORDER BY ts, seq
  LIMIT {limit:UInt32}`;

function chDateTime(at: Date): string {
  return at.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Whether the workspace keeps the text a quote is checked in. A workspace
 * with no policy row keeps every class. A `content_exact` policy must keep
 * both `tool_call` and `model_call` bodies, or it reads as `digest_only`.
 */
export async function resultTextMode(scope: Scope): Promise<ResultTextMode> {
  // tenancy: the scheduled findings job runs outside a tenant scope, and this
  // read is filtered by the pass's orgId and workspaceId.
  const policy = await withSystemDb((tx) =>
    readLatestRetentionPolicy(tx, scope.orgId, scope.workspaceId),
  );
  if (policy === undefined) return "content_exact";
  return policy.mode !== "digest_only" &&
    policy.retainedContentClasses.includes("tool_call") &&
    policy.retainedContentClasses.includes("model_call")
    ? "content_exact"
    : "digest_only";
}

type EvidenceModule = typeof import("@oxagen/run-ledger/evidence-store");

/** The evidence store module, loaded once per read and only when it reads bodies. */
async function loadEvidenceModule(): Promise<EvidenceModule> {
  return import("@oxagen/run-ledger/evidence-store");
}

/**
 * Failures that reading the body again cannot change, as
 * ./findings-prompts.ts names them. The storage driver's
 * `StorageNotFoundError` is matched by name, since this package does not
 * depend on @oxagen/storage.
 */
const LASTING_BODY_FAILURES = new Set([
  "StorageNotFoundError",
  "BodyKeyGoneError",
  "BodyUnopenableError",
  "RangeError",
]);

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A frame's body as text. Null when the control plane kept no body, the row
 * names one this store cannot read, or the body fails for good, is altered,
 * or is not UTF-8. Any other failure is thrown.
 */
async function bodyText(
  scope: Scope,
  store: EvidenceModule,
  row: StepRow,
): Promise<string | null> {
  if (row.bytes_ref === "") return null;
  if (store.parseEvidenceBodyRef(row.bytes_ref) === null) return null;
  let bytes: Uint8Array;
  try {
    ({ bytes } = await runInTenantScope(scope, () =>
      store.evidenceStore().getBody(scope, row.bytes_ref),
    ));
  } catch (err) {
    if (err instanceof Error && LASTING_BODY_FAILURES.has(err.name))
      return null;
    throw err;
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== row.content_digest) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** One chain that holds a large result. */
interface Chain {
  runId: string;
  root: string;
  /** The chain's session uuid: the root's own on the run's chain. */
  session: string;
  results: ToolCallObservation[];
  /** The tokens its large results add, which orders the walk. */
  tokens: number;
}

/** Each chain that holds a large result, the ones whose results add most tokens first. */
function resultChains(
  results: readonly ToolCallObservation[],
  rootByRun: ReadonlyMap<string, string>,
): Chain[] {
  const out = new Map<string, Chain>();
  for (const c of results) {
    const root = rootByRun.get(c.runId);
    if (root === undefined) continue;
    const session = c.sessionUuid ?? root;
    const key = `${c.runId}|${session}`;
    const chain = out.get(key) ?? {
      runId: c.runId,
      root,
      session,
      results: [],
      tokens: 0,
    };
    chain.results.push(c);
    chain.tokens += c.resultTokens ?? 0;
    out.set(key, chain);
  }
  return [...out.values()].sort((a, b) =>
    b.tokens !== a.tokens
      ? b.tokens - a.tokens
      : `${a.runId}|${a.session}` < `${b.runId}|${b.session}`
        ? -1
        : 1,
  );
}

async function readChainRows(
  scope: Scope,
  chain: Chain,
  from: Date,
  limit: number,
): Promise<StepRow[]> {
  const result = await runInTenantScope(scope, () =>
    chSelect<StepRow>({
      query: RESULT_STEPS_QUERY,
      params: {
        root: chain.root,
        chain: chain.session,
        from: chDateTime(from),
        limit,
      },
    }),
  );
  return result.data;
}

/**
 * Whether a later step quoted each of `results`, the large results detector
 * 5 can price. `rootByRun` maps each wrapped run to its root session. On a
 * `digest_only` workspace nothing is read and no result gets a verdict.
 */
export async function readResultUse(
  scope: Scope,
  results: readonly ToolCallObservation[],
  rootByRun: ReadonlyMap<string, string>,
): Promise<ResultUseRead> {
  const mode = await resultTextMode(scope);
  const verdicts = new Map<string, ResultVerdict>();
  if (mode === "digest_only") return { mode, verdicts };
  const chains = resultChains(results, rootByRun);
  if (chains.length === 0) return { mode, verdicts };
  const store = await loadEvidenceModule();
  let budget = RESULT_USE_BODIES_MAX;
  let checked = 0;
  for (const chain of chains) {
    if (budget <= 0) break;
    const first = chain.results.reduce((a, b) =>
      timeOf(b) < timeOf(a) || (timeOf(b) === timeOf(a) && b.seq < a.seq)
        ? b
        : a,
    );
    const limit = Math.min(RESULT_USE_CHAIN_FRAMES_MAX, budget);
    const rows = await readChainRows(scope, chain, first.at, limit + 1);
    if (rows.length > limit) continue;
    const start = timeOf(first);
    const kept = rows.filter((r) => {
      const at = microsOf(r.at);
      return at > start || (at === start && Number(r.seq) >= first.seq);
    });
    budget -= kept.length;
    const bodies: (string | null)[] = [];
    for (let i = 0; i < kept.length; i += BODY_READ_CONCURRENCY)
      bodies.push(
        ...(await Promise.all(
          kept
            .slice(i, i + BODY_READ_CONCURRENCY)
            .map((row) => bodyText(scope, store, row)),
        )),
      );
    const resultSeqs = new Map(
      chain.results.map((c) => [c.seq, resultUseKey(c)]),
    );
    const frames: ChainFrame[] = kept.map((row, i) => {
      const seq = Number(row.seq);
      const resultKey =
        row.kind === "tool_call" && row.source === "hook"
          ? resultSeqs.get(seq)
          : undefined;
      return {
        atMicros: microsOf(row.at),
        seq,
        kind: row.kind === "tool_call" ? "call" : "output",
        body: bodies[i] ?? null,
        ...(resultKey === undefined ? {} : { resultKey }),
      };
    });
    for (const [key, verdict] of chainVerdicts(frames))
      verdicts.set(key, verdict);
    checked += 1;
  }
  logger.info(
    {
      ...scope,
      chains: chains.length,
      checked,
      results: results.length,
      verdicts: verdicts.size,
    },
    "findings: checked large tool results for a later quote",
  );
  return { mode, verdicts };
}
