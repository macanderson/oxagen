# ADR-009 — Unified capability/tool model via `surfaces`

**Date:** 2026-05-28
**Status:** Accepted
**Epic:** Agent Runtime

## Context

The first draft of the agent runtime epic proposed a separate **tool
registry** (`packages/agent/src/tools/registry.ts`) alongside the
existing **capability registry** (`packages/oxagen`). Tools were
"things the agent invokes mid-conversation"; capabilities were
"things humans and apps invoke."

In practice the separation was defensive, not load-bearing. The same
business logic would have to be wrapped twice. Approval and risk are
just metadata.

## Decision

**Unify.** Tools ARE capabilities. A capability declaration gains two
optional fields:

- `surfaces: ('api' | 'mcp' | 'agent')[]` — where the capability is
  exposed. Default `['api', 'mcp']`.
- `agent?: { requiresApproval?, riskLevel?, category? }` — read by the
  chat runtime when the `agent` surface is present.

The manifest gate only requires layer files for surfaces actually
declared. A capability with `surfaces: ['agent']` skips `api`/`mcp`/
`e2e` layers; it still ships `schema`, `unit`, `docs`.

## Alternatives considered

- **Separate tool registry.** Two registries, double the ceremony, no
  meaningful semantic gain. Rejected.
- **Inline tools in the chat code.** Loses the structural parity the
  capability model gives us (API and MCP wrap the same handler).

## Consequences

- The agent runtime materializes its tool list with
  `listCapabilities().filter(c => getSurfaces(c).includes('agent'))`.
- There is no `agent.tool.execute` — the agent invokes any
  agent-surfaced capability directly via the AI SDK tool dispatch.
- `check_manifest.mjs` reads `surfaces` and emits them per
  capability.
- One registry, one ceremony, one source of truth.
- Tradeoff: the `CapabilityDeclaration` shape grows two optional
  fields. Worth it for the eliminated concept.
