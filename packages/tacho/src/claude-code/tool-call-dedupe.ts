/**
 * One tool call, one sealed frame.
 *
 * A session reports each tool call up to three times: the PostToolUse hook
 * seals it with the input and the output, Claude Code's OTel exporter posts a
 * `tool_result` record and a tool span for the same call, and the transcript
 * tailer reads the `tool_result` block back out of the session file. All three
 * carry the same `tool_use_id`, so a run of nine calls held twenty-seven
 * `tool_call` frames, eighteen of them digest only (#3661).
 *
 * The rule is the one ADR-140 settles: the first source to report a
 * `tool_use_id` seals its frame, and a later sighting from another source
 * seals nothing. One ledger serves a session and all of its subagents: a
 * subagent's hook seals on the child's chain, and an OTel record that names
 * no agent seals on the root's. The hook is canonical in practice because it is
 * synchronous with the call and is the only source that carries the body; the
 * ledger states the rule as first-sighting rather than hook-only so a host
 * that runs without hooks still records its tool calls.
 *
 * The one exception is a sighting that brings a body the chain does not hold.
 * A sealed frame cannot be amended, because the chain hash covers every member
 * of it, so the body would otherwise be lost if a digest-only source won the
 * race to report the call. That frame is sealed and stamped
 * `oxagen.tool_call_duplicate_of` with the source that reported first, the way
 * `LlmCallLedger` stamps a second sighting of a model call, so a reader counts
 * one call whatever the sources did.
 *
 * Facts a later sighting carries and the sealed frame lacks (OTel's
 * `tool_result_tokens` and `tool_decision_source`, the transcript's
 * `tool_denial_kind`) are not sealed. ADR-140 records that choice and why the
 * two alternatives are worse: deferring the seal until the sources settle, and
 * keeping the digest-only frames.
 *
 * The ledger also remembers which subagent a call belongs to. Claude Code's
 * OTel records carry no `agent_id`, so a record that names only the
 * `tool_use_id` of a call a subagent's hook claimed is routed to that
 * subagent's chain rather than the root's.
 */

/** The attr a stamped sighting carries, naming the source sealed first. */
export const TOOL_CALL_DUPLICATE_OF_ATTR = "oxagen.tool_call_duplicate_of";

/**
 * How many calls one session family remembers, the root session and its
 * subagents together; older ones are forgotten in order.
 */
export const TOOL_CALL_LEDGER_CAPACITY = 1024;

export type ToolCallVerdict =
  /** The first sighting of this call on this chain: seal it. */
  | { kind: "first" }
  /** A sighting bringing the body the sealed frame lacks: seal it, stamped. */
  | { kind: "body"; of: string }
  /** A call the chain already holds: seal nothing. */
  | { kind: "repeat" };

/** A verdict, and the registration to apply once its row has landed. */
export interface ToolCallSighting {
  verdict: ToolCallVerdict;
  commit: () => void;
}

interface Entry {
  /** The source sealed first, then every source seen since, in order. */
  sources: string[];
  /** Whether a frame carrying this call's body is on the chain. */
  body: boolean;
  /** The subagent whose call this is, when it is not the session's own. */
  owner?: string;
}

/** The ledger's memory, for the recorder state a restart continues from. */
export interface ToolCallLedgerState {
  /**
   * Tool use id, the sources that reported it (first sealed first), body, and
   * the owning subagent. States written before owners were kept have three
   * members.
   */
  calls: Array<
    [string, string[], boolean] | [string, string[], boolean, string]
  >;
}

export class ToolCallLedger {
  private readonly entries = new Map<string, Entry>();

  constructor(state?: ToolCallLedgerState) {
    for (const [id, sources, body, owner] of state?.calls ?? [])
      this.entries.set(id, {
        sources: [...sources],
        body,
        ...(owner !== undefined ? { owner } : {}),
      });
  }

  state(): ToolCallLedgerState {
    return {
      calls: [...this.entries].map(([id, entry]) =>
        entry.owner !== undefined
          ? [id, [...entry.sources], entry.body, entry.owner]
          : [id, [...entry.sources], entry.body],
      ),
    };
  }

  /** The subagent that owns a call, or undefined for the session's own. */
  ownerOf(toolUseId: string): string | undefined {
    return this.entries.get(toolUseId)?.owner;
  }

  /**
   * Note that a subagent owns a call before any row of it is sealed: its
   * `PreToolUse` names the call first, and the OTel records that follow name
   * only the `tool_use_id`. Registers no sighting.
   */
  claim(toolUseId: string, owner: string): void {
    const entry = this.entries.get(toolUseId);
    if (entry !== undefined) {
      entry.owner ??= owner;
      return;
    }
    this.entries.set(toolUseId, { sources: [], body: false, owner });
    this.trim();
  }

  /**
   * Say what a sighting is without registering it. The caller commits once the
   * row that carries the verdict has landed on the chain: a sighting the
   * envelope then refuses must leave no trace, or the source that reports the
   * call next is judged against a frame the chain does not hold.
   *
   * A row with no `tool_use_id` is nothing this can join on (the MCP
   * gateway's own `tool_call` is one), so it is always a first sighting and
   * registers nothing. `owner` is the subagent whose chain the row seals on.
   */
  judge(
    toolUseId: string | undefined,
    source: string,
    hasBody: boolean,
    owner?: string,
  ): ToolCallSighting {
    if (toolUseId === undefined || toolUseId.length === 0)
      return { verdict: { kind: "first" }, commit: () => {} };
    const seen = this.entries.get(toolUseId);
    const first = seen?.sources[0];
    const commit = (): void => {
      const entry: Entry = seen ?? { sources: [], body: false };
      if (!entry.sources.includes(source)) entry.sources.push(source);
      entry.body = entry.body || hasBody;
      if (owner !== undefined) entry.owner ??= owner;
      this.entries.set(toolUseId, entry);
      this.trim();
    };
    if (first === undefined) return { verdict: { kind: "first" }, commit };
    if (hasBody && seen?.body !== true)
      return { verdict: { kind: "body", of: first }, commit };
    return { verdict: { kind: "repeat" }, commit };
  }

  /**
   * Take on the calls another ledger remembered. A call this ledger already
   * holds keeps its own entry. Used when a restart restores a subagent chain
   * whose state an older build wrote with a ledger of its own.
   */
  absorb(state: ToolCallLedgerState): void {
    for (const [id, sources, body] of state.calls) {
      if (!this.entries.has(id))
        this.entries.set(id, { sources: [...sources], body });
    }
    this.trim();
  }

  private trim(): void {
    while (this.entries.size > TOOL_CALL_LEDGER_CAPACITY) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
