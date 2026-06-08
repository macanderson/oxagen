---
name: coding
description: How the agent writes code in the Oxagen monorepo — capability-first, ESM with .js suffixes, no narration comments, @base-ui/react components from @oxagen/ui on the frontend.
metadata:
  weight: high
  category: engineering
---

# Coding in Oxagen

When the user asks the agent to write code, the agent follows the
patterns this skill documents. The standards are not preferences;
they are conditions for the code being accepted by review.

## Capability-driven design

Every feature in Oxagen is a capability. A capability is declared
exactly once in `packages/oxagen/src/contracts/<name>.ts` with its
Zod input and output schemas, then fanned out across the API route,
the MCP tool, the unit test, the E2E stub, and the docs page. Do not
write a route, a tool, or a test that imports its own schema; import
the capability declaration and reuse its `input` and `output` parsers.

Before writing a new capability, query the typed code graph through
the Oxagen plugin to confirm nothing in the registry already covers
the work. Adding a parallel implementation is the most common defect
the gate catches.

## TypeScript conventions

- ESM everywhere. Module imports always carry a `.js` suffix in source
  even though the file on disk is `.ts`. The bundler resolves the
  suffix; the suffix keeps Node ESM happy when the bundle ships.
- `import type { … }` for type-only imports. The repo runs with
  `verbatimModuleSyntax` so this is enforced by the compiler.
- No narration comments. Comments document architectural decisions —
  why this transaction boundary, why this denormalisation, why this
  N+1 is acceptable. They never restate the next line of code.
- Active voice, present tense, and Oxford commas in any prose.

## Frontend aesthetic

User-facing surfaces in `apps/app` use `@base-ui/react` components
imported from `@oxagen/ui` (the coss/Base UI layer). The aesthetic is
stock neutral — zero glass/translucency, zero brand gradient in the
shell. Use `--primary` for brand colour accents; `--accent` is a
neutral grey. Active state is signalled with `data-[active]`, not
`data-[state]`. Both light and dark themes are supported. New
components compose existing primitives from `@oxagen/ui`; copying a
primitive into a feature folder is a defect. Do not introduce Radix
UI, shadcn, or any glassmorphism treatment.

## Performance defaults

- No N+1 queries. Batch and join. A query inside a loop over rows is
  always a bug.
- Every tenant-scoped query filters on an indexed `tenant_id` plus
  `workspace_id` where relevant. An unindexed scoped query is both a
  performance and an isolation defect.
- Paginate every list endpoint. No endpoint returns "all rows".
- Stream or chunk anything that could plausibly exceed a few MB.

## Memory write-back

When the agent completes a non-trivial change, it records a weighted
memory against the touched graph node via `agent.memory.write` so the
next agent inherits the lesson rather than rediscovering it. Pick the
weight honestly: `low` for one-off observations, `high` for lessons
that will save the next contributor real time, `critical` for
gotchas that would have caused an outage if missed.
