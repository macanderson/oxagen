# Agent Skills — Current State

> Audited 2026-06-12 against `main`. Covers the Oxagen **product** skills system
> (`agent.skills` / `agent.skill_versions` in Postgres), not the repo's Claude Code
> authoring skills in `.agents/skills/`.

## What a skill is

A skill is a versioned markdown knowledge artifact — YAML frontmatter
(`name`, `description`, `metadata: { weight, category }`) plus a markdown body —
that an agent can load at runtime to learn *how* to do something (coding
conventions, debugging methodology, summarization style). Skills are knowledge,
not executable tools: loading one returns prose the model reads, plus a list of
capability slugs the body references (`## Capability: <slug>` lines or
frontmatter `capabilities: [...]`).

Design is **filesystem-first with DB augmentation** (ADR-008,
`docs/adr/ADR-008-skills-filesystem-first.md`): built-ins live as
`*.skill.md` files under source control; tenant-authored skills live in
Postgres and shadow built-ins on slug collision.

## Out-of-the-box skills (5)

Seeded by `pnpm db:seed-skills` (`tools/scripts/seed-skills.ts`, idempotent
`ON CONFLICT DO NOTHING`) from `packages/skills/skills/`. The shipped skills are
**generic customer starters** — they teach an agent good general practice, not
Oxagen's internal monorepo conventions, so a customer can use or adapt them
immediately:

| Slug | Category | Purpose |
|---|---|---|
| `coding` | engineering | Understand before writing, match the codebase, small reviewable changes, test what you write, security and performance defaults |
| `debugging` | engineering | Reproduce → read the real error → narrow down → fix the root cause not the symptom → land a regression test |
| `summarization` | writing | Lead with the conclusion, anchor evidence to sources, never drop a pending action, compaction rules |
| `skill-builder` | meta | How to author a new skill — frontmatter shape, body structure, when a skill is worth writing, keeping it generic and token-efficient |
| `agent-builder` | meta | How the in-app agent designs, configures, and deploys agents — instructions, graph access, tools, triggers/event-filters, deploy inactive then activate on request |

Built-ins are stamped with sentinel nil-UUID org/workspace IDs to mark them
platform-global.

## Storage

- `agent.skills` (`packages/database/src/schema/agent.ts:63`) — identity:
  `(workspace_id, slug)` unique; `source` = `builtin` | `tenant`; `enabled`
  toggle; org/workspace scoped; soft-delete.
- `agent.skill_versions` (`:85`) — immutable INSERT-only version snapshots
  (`version_number`, `is_latest` partial-unique, `parent_version_id` lineage,
  full markdown `body`, `references_payload` jsonb). Versioning exists for
  replay determinism.
- `packages/skills/` — zero-DB-dependency loader/registry. `createSkillRegistry`
  merges filesystem + DB rows (tenant wins slug collisions), caches until
  `refresh()`. Loader validates frontmatter and lazily resolves a
  `## References` section pointing at sibling docs.

## Capabilities (the entire runtime surface)

| Capability | Surfaces | What it does |
|---|---|---|
| `agent.skill.list` | api, mcp, agent | List workspace skills (slug, name, description, source, version); optional substring filter |
| `agent.skill.load` | api, mcp, agent | Load a skill body by slug + semver-ish constraint (`3`, `^2`, `~2`, latest); extracts referenced capability slugs; non-blocking dependency validation |
| `skill.workspace.list` | api, mcp | Admin-facing list (id, name, description, enabled) |

All three are read-only, risk `low`, no approval. Handlers:
`packages/agent/src/handlers/agent.skill.{list,load}.ts`,
`packages/handlers/src/skill.workspace.list.ts`. There is **no**
`skill.create` / `skill.update` / `skill.delete` / `skill.enable` capability —
the `source: "tenant"` path is schema-ready but has no write surface.

## How skills are used at runtime

**Lazy, agent-driven, opt-in.** Skills are never injected into the system
prompt. `materializeTools` (`packages/agent/src/runtime/materialize-tools.ts`)
advertises every `agent`-surfaced capability — which includes
`agent.skill.list` and `agent.skill.load` — so the in-app chat agent *can*
discover and load skills as ordinary tool calls. The intended loop:

1. Agent calls `agent.skill.list` → sees what guidance exists.
2. Agent calls `agent.skill.load({ skillSlug })` → receives the markdown body.
3. Agent applies it, then records learnings via `agent.memory.write`.

**Gap:** the chat system prompt (`packages/ai/src/prompts/registry.ts`,
`chatSystemPrompt`) never mentions skills, so in practice the model rarely
knows to call these tools. The infrastructure is wired; the *habit* is not
prompted.

## Token efficiency

Yes — by construction:

- System prompt stays small (~250 tokens baseline) and is prompt-cached
  (`cacheControl: ephemeral` in `packages/ai/src/stream.ts`). Skill content
  never bloats the cached prefix.
- Skill bodies (~1–2k tokens each) enter context only when explicitly loaded.
- Cost of the model *not knowing* skills exist is the real inefficiency:
  guidance that would prevent wasted turns goes unused.

There is no progressive disclosure beyond list-then-load, and no semantic
(embedding/trigger) matching — selection is entirely up to the model.

## Surface-by-surface answers

**App UI / chat prompt:** No user control exists. No skill picker, no settings
page, no `/skill` or `@skill` syntax in the ask bar, no `skills` field in
`PromptConfig` (`prompt.settings.*` customization is freeform
`additionalInstructions` only — not skill-aware). A user can only influence
loading by literally asking the agent to "load the coding skill," which works
because the tools are materialized.

**CLI:** Read-only introspection only — `oxagen agent skill list` and
`skill workspace list` command files exist (`apps/cli/src/commands/`). There
are no flags to enable/disable/pin skills for an agent run.

**MCP server:** It exposes the three skill capabilities as MCP *tools*
(`apps/mcp/src/tools/agent.skill.{list,load}.ts`, `skill.workspace.list.ts`),
so a connected client's model can list/load skills. But `apps/mcp` runs no LLM
of its own — its other tool responses are deterministic capability invocations
and do **not** incorporate skill content. Skills affect MCP sessions only when
the client model chooses to call the skill tools.

**Parity matrix:**

| Operation | App UI | API | MCP | CLI | Agent |
|---|---|---|---|---|---|
| List skills | ✗ | ✓ | ✓ | ✓ | ✓ |
| Load skill body | ✗ | ✓ | ✓ | ✗ | ✓ |
| Create / edit / version | ✗ | ✗ | ✗ | ✗ | ✗ |
| Enable / disable | ✗ | ✗ | ✗ | ✗ | ✗ |
| Pin skills for a session | ✗ | ✗ | ✗ | ✗ | ✗ |

## Improvement opportunities

Ordered by leverage:

1. **Prompt the habit (cheapest, highest impact).** Inject a one-line-per-skill
   index (slug + description, ~15 tokens each) into `chatSystemPrompt` with an
   instruction to `agent.skill.load` when relevant. This is the
   metadata-first / progressive-disclosure pattern Claude Code itself uses, and
   it converts dormant infrastructure into behavior for ~50 cached tokens.
2. **Authoring surface.** `skill.create` / `skill.update` / `skill.enable`
   contracts → API → MCP → CLI → a workspace settings page. The schema
   (versioning, shadowing, soft-delete, audit) is already built; this is the
   missing half of ADR-008's tenant story. Differentiator: users could tell the
   *chat agent* "turn what you just learned into a skill" — agent-authored,
   human-approved skills, closing the loop with `agent.memory.write`.
3. **Session-level pinning.** `skills: string[]` on chat-stream input +
   `PromptConfig`, an `@skill` mention in the ask bar, and a `--skill` CLI
   flag. Pinned skills get prepended (cache-safely, after the static prefix).
4. **Auto-suggestion, not auto-injection.** Embed skill descriptions
   (`embeddingModel` via the gateway) and surface top-k matches to the model as
   a hint ("relevant skills: …") rather than stuffing bodies — keeps the token
   discipline while fixing discoverability.
5. **Skill→capability synergy.** `agent.skill.load` already extracts
   capability slugs; use them to expand the session's tool allowlist when a
   skill is loaded ("loading the `ingestion` skill equips the ingestion
   tools"). No other framework ties knowledge artifacts to authorization-aware
   tool surfaces.
6. **Observability.** Meter skill loads in ClickHouse with outcome attribution
   (did loading `debugging` shorten failure investigations?) — skills become
   measurable, promotable assets.

## Known gaps / follow-ups

- `docs/capabilities/` covers `agent.skill.list` / `agent.skill.load`; ensure
  `skill.workspace.list` is documented when touched.
- `agent.skill.load` is absent from the CLI (parity gap with API/MCP).
- The `debugging` built-in references `ontology.*` graph capabilities that are
  not yet shipped — the skill's guidance is partially aspirational.
