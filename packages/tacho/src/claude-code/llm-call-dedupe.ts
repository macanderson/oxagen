/**
 * One model call, one counted row.
 *
 * A session reports each model call up to three times: the loopback proxy
 * seals it as it observes the response, Claude Code's OTel exporter posts an
 * `api_request` record, and the transcript writes the `assistant` message.
 * Each carries facts the others do not (the proxy has the wire bytes, OTel
 * has cost and duration, the transcript has the cache split and thinking
 * tokens), so all three belong on the chain. What must not happen is that
 * the control plane adds the same call's tokens three times.
 *
 * `event_id_idem` cannot carry this: it is derived from `(session_uuid, seq)`
 * and the chain verifier checks that derivation, so it dedupes retries of one
 * chain position, never two positions that describe one call. The join key
 * is the vendor's `request_id`, which all three sources carry (the proxy
 * from the `request-id` response header, OTel from its `request_id`
 * attribute, the transcript from the record's `requestId`), with the
 * message id as the next key and the token tuple as the last resort for a
 * source that carries neither.
 *
 * One ledger serves a session and all of its subagents, because a
 * subagent's call reaches more than one chain: the proxy seals it on the
 * root session and the subagent's transcript seals it on the child's. The
 * ledger remembers what the family has sealed and answers, for each new
 * `llm_call`, whether it is the first sighting of its call, a second sighting
 * from another source (sealed, stamped `oxagen.llm_call_duplicate_of` with
 * the first source so the control plane counts the tokens once), or a repeat
 * from the same source. The recorder drops an OTel repeat, which carries
 * nothing the chain lacks, and seals a transcript repeat as a continuation
 * block with its usage removed (see `LLM_CALL_USAGE_KEYS`).
 */
import { LLM_CALL_DUPLICATE_OF_ATTR } from "../evidence/replay-grade";

/** The attr a later sighting carries, naming the source sealed first. */
export { LLM_CALL_DUPLICATE_OF_ATTR };

/**
 * The body members that count. Claude Code writes one `assistant` record per
 * content block (`apiBlockIndex` 0, 1, 2, ...), every one carrying the whole
 * message's usage, so a three-block reply is three records that would each
 * add the call's tokens. The first block seals the usage; the later blocks
 * seal their text with these members removed, so no reader of the chain, on
 * this build or an older one, can add the call more than once.
 */
export const LLM_CALL_USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "cache_creation_5m_tokens",
  "cache_creation_1h_tokens",
  "thinking_tokens",
  "web_search_requests",
  "web_fetch_requests",
  "iterations",
  "cost_usd_micros",
  "api_duration_ms",
  "ttft_ms",
] as const;

/** The body without its usage: what a continuation block keeps. */
export function withoutUsage(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...body };
  for (const key of LLM_CALL_USAGE_KEYS) delete out[key];
  return out;
}

/**
 * The sources whose `llm_call` rows carry a call's own usage. `otel_span`
 * mirrors the log record and is never counted; `result` totals are session
 * sums, not calls. The transcript joined this list when the daemon began to
 * tail it (and the ledger began to stamp the rows that would double up).
 */
export const LLM_CALL_TOKEN_SOURCES = [
  "otel_log",
  "collector",
  "hook",
  "transcript",
] as const;

/**
 * Whether one row's token columns count toward the session's usage. The
 * rule the control plane and the rollup share: a token-bearing source, and
 * no `oxagen.llm_call_duplicate_of` stamp (a later sighting of a call the
 * chain already counted, or a continuation block of a transcript message).
 * The split and thinking columns are read separately, from transcript rows,
 * because they exist nowhere else; see `countsLlmCallSplit`.
 */
export function countsLlmCallUsage(event: {
  kind: string;
  source: string;
  attrs: Record<string, string>;
}): boolean {
  return (
    event.kind === "llm_call" &&
    (LLM_CALL_TOKEN_SOURCES as readonly string[]).includes(event.source) &&
    event.attrs[LLM_CALL_DUPLICATE_OF_ATTR] === undefined
  );
}

/**
 * Whether one row's cache split and thinking columns count. A transcript row
 * carries them whether it was the first sighting or a duplicate of an OTel
 * or proxy row; a transcript continuation block (stamped as a duplicate of
 * `transcript`) had them removed and adds nothing.
 */
export function countsLlmCallSplit(event: {
  kind: string;
  source: string;
  attrs: Record<string, string>;
}): boolean {
  return (
    event.kind === "llm_call" &&
    event.source === "transcript" &&
    event.attrs[LLM_CALL_DUPLICATE_OF_ATTR] !== "transcript"
  );
}

/**
 * How many keys one session family remembers, the root session and its
 * subagents together; older ones are forgotten in order. Parallel subagents
 * fill it faster than one chain would.
 * Each call can register under up to three keys (a request id, a message
 * id, and a tuple), so 1024 entries held room for roughly 340 calls — a
 * transcript tailer running behind the live sources by more than that in
 * one session aged its earliest calls out of the ledger before the
 * transcript ever reported them, and they were sealed as first sightings
 * a second time rather than recognised as duplicates. 8192 gives a lagging
 * transcript room for a session over 2500 calls deep before the same thing
 * recurs.
 */
export const LLM_CALL_LEDGER_CAPACITY = 8192;

export type LlmCallVerdict =
  | { kind: "first" }
  | { kind: "duplicate"; of: string }
  | { kind: "repeat" };

/** A verdict, and the registration to apply once its row has landed. */
export interface LlmCallSighting {
  verdict: LlmCallVerdict;
  commit: () => void;
}

interface Entry {
  /** The source sealed first, then every source seen since, in order. */
  sources: string[];
  /** Whether the entry was registered under an id, not only under its tuple. */
  identified: boolean;
}

/** The ledger's memory, for the recorder state a restart continues from. */
export interface LlmCallLedgerState {
  /** Key, the sources that reported it (first sealed first), identified. */
  keys: Array<[string, string[], boolean]>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The id keys of a call, strongest first, and the token tuple. Two distinct
 * calls in one session can share a tuple (a title prompt asked twice), so
 * the tuple only ever joins one id-less sighting to another id-less one. An
 * id-less sighting matched to an already-identified entry by tuple alone
 * used to be sealed as a duplicate of a call it might not be — two 0-token
 * calls share a tuple trivially — and its usage silently dropped rather
 * than doubled. Two identified sightings whose ids differ are two calls
 * whatever their tuples say, tuple or no tuple.
 */
export function llmCallKeys(body: Record<string, unknown>): {
  ids: string[];
  tuple: string | undefined;
} {
  const ids: string[] = [];
  const request = str(body["request_id"]);
  const message = str(body["message_id"]);
  if (request !== undefined) ids.push(`request:${request}`);
  if (message !== undefined) ids.push(`message:${message}`);
  const counts = [
    num(body["input_tokens"]),
    num(body["output_tokens"]),
    num(body["cache_read_tokens"]),
    num(body["cache_creation_tokens"]),
  ];
  const tuple = counts.some((count) => count !== undefined)
    ? `tuple:${str(body["model"]) ?? ""}|${counts.map((count) => count ?? "").join("|")}`
    : undefined;
  return { ids, tuple };
}

export class LlmCallLedger {
  private readonly entries = new Map<string, Entry>();

  constructor(state?: LlmCallLedgerState) {
    for (const [key, sources, identified] of state?.keys ?? [])
      this.entries.set(key, { sources: [...sources], identified });
  }

  state(): LlmCallLedgerState {
    return {
      keys: [...this.entries].map(([key, entry]) => [
        key,
        [...entry.sources],
        entry.identified,
      ]),
    };
  }

  /** Register a sighting and say what it is. */
  note(body: Record<string, unknown>, source: string): LlmCallVerdict {
    const sighting = this.judge(body, source);
    sighting.commit();
    return sighting.verdict;
  }

  /**
   * Say what a sighting is without registering it. The caller commits once
   * the row that carries the verdict has landed on the chain: a sighting the
   * envelope then refuses must leave no trace, or the next source to report
   * the call is stamped a duplicate of a row that does not exist and the
   * call's usage is never counted. Nothing else may touch the ledger
   * between `judge` and `commit`.
   */
  judge(body: Record<string, unknown>, source: string): LlmCallSighting {
    const { ids, tuple } = llmCallKeys(body);
    const identified = ids.length > 0;
    let byId: Entry | undefined;
    for (const id of ids) {
      byId = this.entries.get(id);
      if (byId !== undefined) break;
    }
    let byTuple: Entry | undefined;
    if (byId === undefined && tuple !== undefined) {
      const candidate = this.entries.get(tuple);
      // Only an id-less sighting may join an id-less entry by tuple alone.
      // Letting an id-less sighting join an already-identified entry (or
      // the reverse) treated two calls that merely share a token tuple as
      // one, and the joined sighting's usage was then never counted.
      if (candidate !== undefined && !identified && !candidate.identified)
        byTuple = candidate;
    }
    const seen = byId ?? byTuple;
    const first = seen?.sources[0];
    const reported = seen?.sources.includes(source) ?? false;
    const commit = (): void => {
      const entry: Entry = seen ?? { sources: [], identified };
      if (!entry.sources.includes(source)) entry.sources.push(source);
      for (const key of [...ids, ...(tuple !== undefined ? [tuple] : [])]) {
        if (!this.entries.has(key)) this.entries.set(key, entry);
      }
      this.trim();
    };
    let verdict: LlmCallVerdict;
    if (first === undefined) verdict = { kind: "first" };
    // A source reporting a call it already reported. Under an id that is a
    // re-read of a record the chain holds. Under a tuple alone it may be two
    // calls that happen to match, and a source that cannot tell them apart
    // must count both.
    else if (reported)
      verdict = byId !== undefined ? { kind: "repeat" } : { kind: "first" };
    else verdict = { kind: "duplicate", of: first };
    return { verdict, commit };
  }

  /**
   * Take on the keys another ledger remembered. A key this ledger already
   * holds keeps its own entry. Used when a restart restores a subagent chain
   * whose state an older build wrote with a ledger of its own.
   */
  absorb(state: LlmCallLedgerState): void {
    for (const [key, sources, identified] of state.keys) {
      if (!this.entries.has(key))
        this.entries.set(key, { sources: [...sources], identified });
    }
    this.trim();
  }

  private trim(): void {
    while (this.entries.size > LLM_CALL_LEDGER_CAPACITY) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
