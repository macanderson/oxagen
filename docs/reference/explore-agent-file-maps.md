> **Snapshot — superseded.** This document was captured before the capabilities architecture was finalized. The `registerCapability` / no-`defineContract` findings in the examples below reflect pre-architecture code that no longer exists. For current state see [`docs/architecture/iam/plan.md`](../architecture/iam/plan.md).

# Reference — What an `Explore` agent "file-level map" looks like

When you dispatch an `Explore` (or `general-purpose`) subagent to map part of the
codebase, the agent reads excerpts across many files and returns a **single
structured markdown report** as its final message. That report — not the files it
read — is what lands back in the parent's context. The agent is a *context
isolation tool*: it burns its own tokens reading 70–100 files and hands you back a
few thousand tokens of distilled, anchored conclusions.

This document shows the **actual shape** of those returns, captured verbatim from
a real session (the Wave-1 IAM "tenant → org" rename mapping, 2026-05-29). Use it
to calibrate what to ask for and what good output looks like.

---

## The contract: what you get back

An Explore agent's final message is **the return value**, not a chat message. Good
maps share these properties:

1. **Structured by question.** One section per thing you asked. If you number your
   prompt's asks, the report mirrors that numbering.
2. **`file:line` anchored everywhere.** Every claim points at `path:line` so the
   parent can jump straight to the edit without re-searching. This is the single
   most valuable property — it's clickable and verifiable.
3. **Tables for breadth, excerpts for depth.** Wide "which files touch X" data
   comes back as a table; the 2–3 load-bearing files come back as quoted code.
4. **A consolidated action checklist at the end** — a per-file "what must change"
   list, dependency-ordered. This is the part you actually execute against.
5. **Excerpts, not whole files.** The agent quotes the 5–15 relevant lines, never
   the entire file. If it dumps whole files, the prompt asked wrong.

The metadata you also receive (outside the report body):

```
subagent_tokens: 92348      # what the agent spent reading — isolated from your context
tool_uses: 74               # how many reads/greps it ran
duration_ms: 272335         # wall-clock
```

---

## Example 1 — A single-file deep excerpt

When you ask for "full content / exact shape" of a load-bearing file, the agent
returns the relevant code plus a structural breakdown. This is from a request to
map the capability-contract definition helper:

> ### 3. The Contract-Definition Helper — `registerCapability`
>
> **File:** `packages/oxagen/src/registry.ts`
>
> ```ts
> export function registerCapability<C extends CapabilityDeclaration>(cap: C): C {
>   if (registry.has(cap.name)) {
>     throw new Error(`Capability "${cap.name}" already registered`);
>   }
>   registry.set(cap.name, cap as CapabilityDeclaration);
>   return cap;
> }
> ```
>
> **There is no `defineContract` helper, no `.withMetadata(...)` chain, and no
> builder pattern.** `registerCapability` accepts a plain object conforming to
> `CapabilityDeclaration` and returns it unchanged (but registered).

Note the shape: **path → quoted code → a plain-language finding that answers the
question you actually had** ("can I hang metadata off a builder?" → "no, here's
why, here's the field to add instead"). The agent doesn't just show the code; it
draws the conclusion the parent needs to make a decision.

---

## Example 2 — A "fields this type carries" table

When the question is "what can this structure hold," the return is a table with
type, required-ness, and purpose — denser and more scannable than prose:

> **What fields `CapabilityDeclaration` can carry today** (`packages/oxagen/src/types.ts`, lines 30–49):
>
> | Field | Type | Required | Description |
> |---|---|---|---|
> | `name` | `string` | yes | Dot-notation capability id |
> | `domain` | `string` | yes | Grouping bucket |
> | `mode` | `ExecutionMode` | yes | `"sync" \| "async" \| "batch"` |
> | `surfaces` | `readonly CapabilitySurface[]` | no | defaults `["api","mcp"]` |
> | `input` | `TInput extends ZodTypeAny` | yes | Zod input schema |
> | `output` | `TOutput extends ZodTypeAny` | yes | Zod output schema |
> | `scoped` | `boolean` | no | Whether workspace scope is enforced. Default `true`. |

---

## Example 3 — A "breadth sweep" table (which files touch X)

This is the workhorse output for a rename/refactor: every site that references the
thing, with line numbers and a one-word classification of *what kind* of reference
it is (so you know which need real thought vs. mechanical swaps).

> ### `packages/agent` — tenant references
>
> | File | Line(s) | Kind of reference |
> |---|---|---|
> | `src/types.ts` | 5 | Type field — `tenantId: string` in `CapabilityContext` |
> | `src/handlers/agent.approval.resolve.ts` | 33, 36 | DB query WHERE clause |
> | `src/handlers/agent.code.execute.ts` | 31, 49 | `applyPolicy` arg + telemetry row field |
> | `src/memory/neo4j.ts` | 20, 34, 51, 75, 93, 119 | Cypher `WHERE node.tenantId = $tenantId` |
> | `src/runtime/materialize-tools.ts` | 96, 115, 147 | `CapabilityContext` field + telemetry row |

The "Kind of reference" column is what separates a useful map from `grep` output:
it tells you `neo4j.ts` is Cypher string interpolation (careful) while
`approval.resolve.ts` is a typed column reference (mechanical).

---

## Example 4 — A per-table structural map (DB schema)

For schema work, the agent returns table-by-table: name, PK prefix, columns,
indexes — everything needed to write a migration without re-opening the file:

> #### `organization.tenants` (lines 6–21)
> - Schema: `organizationSchema`
> - PK prefix: `"ten"` (via `idMixin("ten")`) → public IDs like `ten_XXXX`
> - Columns: `id` uuid PK, `public_id` citext unique, audit cols, `name` text NOT
>   NULL, `slug` citext NOT NULL, `plan_type` text NOT NULL, `status` text NOT NULL,
>   `settings` jsonb NOT NULL DEFAULT `'{}'`
> - Indexes:
>   - `tenants_slug_idx` UNIQUE on `slug`
>   - `tenants_status_idx` on `status`

---

## Example 5 — The consolidated action checklist (the payload)

Every good map ends with a dependency-ordered, copy-pasteable checklist. This is
what you execute against — the rest of the report is its justification.

> ### A. Filesystem moves (git mv)
> - [ ] `git mv apps/app/src/app/[tenantSlug] apps/app/src/app/[orgSlug]`
> - [ ] `git mv apps/app/src/app/(onboarding)/new-tenant apps/app/src/app/(onboarding)/new-org`
> - [ ] `git mv apps/app/src/components/tenant apps/app/src/components/org`
>
> ### G. `apps/app/src/components/shell/topbar.tsx`
> - [ ] Import `TenantSwitcher` from `@/components/org/org-switcher`
> - [ ] Prop `availableTenants` → `availableOrgs`
> - [ ] `tenant: ResolvedTenant` → `org: ResolvedOrg`
> - [ ] `<TenantSwitcher ...>` → `<OrgSwitcher ...>`

It also flags **judgment calls it won't make for you** — the items where a blind
rename would be wrong:

> - [ ] `metadata: { tenantId: ... }` — these are **Stripe metadata keys sent to
>   Stripe**; decide whether to rename in Stripe too before changing lines 63–64.

That "decide before changing" annotation is a hallmark of a good map: the agent
surfaces the cross-system boundary instead of silently renaming through it.

---

## How to prompt for this shape

The maps above came from prompts that did the following — copy this structure:

1. **State the downstream goal**, so the agent knows what's load-bearing:
   *"Map X for an upcoming tenant→org rename and a new IAM schema."*
2. **Number your asks**, each one concrete:
   *"1. `_schemas.ts` — full content … 6. Every other schema file — for each, list
   ONLY which mixin/column it uses and roughly how many references."*
3. **Calibrate depth per item explicitly:**
   *"Be exhaustive on items 1–3 and 9–10; concise on item 6."*
4. **Demand anchors and a final checklist:**
   *"Output a structured markdown checklist organized by 'what must be renamed',
   with exact file paths and line numbers."*
5. **Tell it to read excerpts, not dump files** — keeps its return tight and its
   own context from overflowing.

### Anti-patterns (what makes a map useless)

- No line numbers → you re-search everything the agent already found.
- Whole-file dumps → blows up your context, defeats the isolation purpose.
- Prose paragraphs where a table belongs → unscannable for breadth data.
- No final checklist → you have facts but no execution order.
- Silently renaming through a system boundary instead of flagging it.

---

## When to use this vs. doing it yourself

| Situation | Use Explore agent? |
|---|---|
| "Which of 144 files reference `tenant`?" | **Yes** — breadth sweep, isolates the noise |
| "What's the exact shape of this one type I'm about to edit?" | Usually no — just `Read` it |
| "Map 4 unrelated subsystems before a big change" | **Yes, in parallel** — one agent each |
| "Find the single file that defines `registerCapability`" | Borderline — `Grep` is faster if you're confident |

Rule of thumb from `CLAUDE.md`: *a subagent is a context-isolation tool, not a
default.* Reach for it when the reading would blow up the parent's context, or when
several independent areas can be mapped concurrently — exactly the four-agent
fan-out that produced the examples above.
