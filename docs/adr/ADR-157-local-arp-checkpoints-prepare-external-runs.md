# ADR-157: Local ARP checkpoints prepare external runs

Status: Accepted
Date: 2026-09-19
Related: ADR-035, ADR-036, ADR-043, ADR-058, ADR-100, ADR-101

## Context

You may want to continue a run in another harness or compare several candidates from the same recorded turn. Tacho's evidence chain identifies recorded frames. A frame alone does not carry the workspace files or native model state needed to resume work.

Oxagen governs agents and keeps their record. A transfer feature must preserve that boundary and identify which parts of a run it can carry.

Context Graph Protocol already supplies context frames, content identity, provenance, costs, fidelity, and full, compact, and reference representations. The separate `contextgraph-trace` sketch supplies host journal vocabulary and replay checks. Tacho already ports that journal's types, projection, and checks. Repeating those contracts inside ARP would create competing definitions for the same evidence.

## Decision

Add an offline Agent Run Protocol slice to the Tacho CLI with three commands: `arp capture`, `arp verify`, and `arp prepare`.

Build ARP on CGP. Carry the operator's handoff summary as an existing CGP `episode` frame with the full representation. Reuse CGP's identity and representation semantics. Full representation describes the supplied summary's bytes, not the completeness of the source conversation. ARP defines no new context frame or journal schema.

Reuse Tacho's projection and replay checks for source evidence. Pin the journal by its explicit `TRACE_FORMAT`, currently `contextgraph-trace/0.1-sketch`. The journal remains a sketch outside core `contextgraph/1.0`, and its package version is not a wire compatibility promise. Preserve the original `tacho/1.0` evidence beside any derived checks.

ARP owns the transfer contract: a restorable snapshot bound to an exact source record boundary, destination admission and launch preparation, and experiment lineage. A CGP frame identifies context content. The ARP source locator names the precise position in the evidence stream that the operator associates with the snapshot. This local slice implements capture, verification, and preparation. It does not implement policy admission or experiment management.

Capture requires a Tacho export ending at `turn_end`, an explicit file selection, an operator-authored brief, export approval in that brief, an existing signing key, and an assertion that the stopped workspace matches the evidence boundary. The checkpoint binds those materials with a signature. Capture does not infer historical file state or enforce process quiescence. Its boundary assertion is client-attested.

Verification requires a public key pinned independently by the recipient. Preparation verifies the checkpoint and creates a separate workspace, a prompt file, a compatibility report, and a native command description. Every destination starts a fresh history. The report records information loss because the transfer carries selected files and an explicit summary rather than native model state.

Claude Code, Codex, Cursor, and Stella each accept the prepared prompt through their ordinary CLI arguments. The operator selects the harness and starts it separately. ARP launches no workload, sets no permission-bypass flags, and changes no global configuration.

The brief's export approval is an operator assertion. It is not an organization policy grant. Imported approvals and context cannot override active destination rules. Existing governance continues to apply to actions routed through Oxagen.

## Consequences

The local tool can prepare multiple candidate workspaces from the same signed checkpoint. It does not schedule candidates, isolate their external effects, rank their results, or promote a winner. Those controls require a separate design.

The source record remains evidence rather than a rewritten destination history. The recipient can verify integrity under its pinned key but still needs to assess the source brief, selected files, and omitted dependencies. A signature does not prove that the operator stopped the source at the named boundary.

The [local checkpoint specification](../specs/agent-run-protocol.md) documents the brief, commands, and limits. This decision covers offline capture and preparation for external harnesses. It does not turn Oxagen into a managed workload runner.
