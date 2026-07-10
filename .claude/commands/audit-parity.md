---
description: Run a backend↔frontend capability parity audit and produce a ranked gap backlog
argument-hint: [scope: whole product, a domain, or an API subtree]
allowed-tools: Read, Grep, Glob, Bash
---

Scope: $ARGUMENTS (default: the whole product)

Delegate to the **parity-auditor** agent for the scoped area. Requirements
for this run:

1. Inventory ALL eight capability sources (endpoints; per-endpoint params —
   every optional filter/sort/expansion/bulk/pagination flag is a
   sub-capability; webhook/event types; async job lifecycle states; RBAC
   permissions never checked by UI; feature/entitlement gates; SDK/CLI-only
   operations; API error codes).
2. Classify every capability: FULLY SURFACED / PARTIALLY SURFACED (list
   exactly what's missing) / SURFACED BUT UNDISCOVERABLE / NOT SURFACED /
   INTENTIONALLY HEADLESS (written justification required) / FRONTEND ORPHAN.
3. Flag permission asymmetries — especially enabled UI the API will reject.
4. Deliver the parity matrix with file:line evidence, the gap backlog ranked
   by (user value × frequency × differentiation) ÷ build cost, the
   immediate-fix list, and coverage percentages compared against the last
   run's numbers from the auditor's memory.

For each top-10 gap, queue a follow-up: hand it to **ux-architect** for a
surfacing spec.
