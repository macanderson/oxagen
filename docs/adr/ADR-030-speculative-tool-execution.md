# ADR-030: Speculative tool execution — prefetch the model's next reads while it thinks

- **Status:** Accepted
- **Date:** 2026-07-11
- **Owners:** agent-engine
- **Related:** ADR-021 (inference doctrine — deterministic-before-model),
  ADR-029 (mutation verifier gate)

## Context

Reads dominate agent turns: the majority of tool calls are `read_file`,
`grep`, `glob`, and `list_dir`, and each one costs a full model round-trip of
latency — the agent asks, waits for the filesystem, then thinks again. Yet the
NEXT read is often knowable the moment the current one returns:

- An over-cap `read_file` result literally embeds the follow-up call in its
  truncation marker ("call read_file with offset:N, limit:M").
- A `grep` hit list is, with high probability, followed by reads of the top
  matching files.
- A `glob` listing is followed by reads of its first entries.

Speculative decoding exploits exactly this shape at the token level; nothing
exploited it at the tool level. The engine pays sequential latency for
predictable I/O.

## Decision

A **speculation layer** (`packages/agent-engine/src/speculate/`) wraps the
workspace ToolSet inside `runCodingAgent`, ON by default with a kill switch
(`OXAGEN_SPECULATIVE_TOOLS=0`; the `RunCodingAgentOptions.speculativeTools`
option wins):

1. **Read-only allowlist, hard-coded.** Only `read_file`, `grep`, `glob`, and
   `list_dir` are ever speculated or served from cache. Mutating tools
   (`write_file`, `edit_file`, `bash`) are never speculated — observing one of
   them **invalidates the entire cache**, because a mutation (especially bash)
   may change anything. Extra tools (MCP) and structured tools pass through
   untouched.
2. **Deterministic predictor, injectable port.** After each real read-tool
   result, a pure predictor proposes the likely next calls (truncation-marker
   follow-up; top distinct `grep` hit files; first `glob` entries — capped).
   It is a port (`SpeculationPredictor`) so a local draft model can replace
   the heuristics later without touching the layer.
3. **Cache of in-flight promises.** Speculative executions run against the
   same wrapped tool (bounded concurrency, bounded cache size) and store their
   promise keyed by canonical input JSON. A real call that matches awaits the
   SAME promise — hit or still-in-flight, the filesystem work is never done
   twice. Tool results are strings by contract (errors included), so caching
   the resolved value is uniform and a speculated failure serves exactly what
   a live call would have returned.
4. **Placement: inside `wrapTools`, outside the workspace.** The layer wraps
   the already-backstopped workspace tools BEFORE `extraTools` merge and the
   caller's `wrapTools` (permission gate). This is sound because the allowlist
   is read-only: workspace-level permission brokering only guards mutations,
   which the layer never issues. Served cache hits still flow through the
   caller's outer wrappers on the real call.

## Consequences

- Predictable follow-up reads return instantly; the read-heavy middle of a
  turn loses most of its filesystem latency. Wasted speculative reads cost
  only local I/O that an OS page cache absorbs.
- Correctness risk is confined by design: read-only allowlist, whole-cache
  invalidation on any mutation, per-turn lifetime (the cache dies with the
  ToolSet).
- Stats (`predicted/hits/misses/wasted/invalidations`) are exposed via an
  injectable callback for future trace/eval wiring; no new event-envelope
  variant is introduced (the app's envelope copies stay untouched).
- The predictor port is the seam where Phase 2's "tiny local draft model"
  lands later; swapping it is a one-line injection, not a redesign.
