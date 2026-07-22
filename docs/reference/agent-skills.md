# Agent Skills — Current State

> Audited 2026-07-21 against `main`. Covers the Oxagen **product** skills system
> (`agent.skills` / `agent.skill_versions` in Postgres) and the canonical TOML
> artifact format shared by agents, skills, and slash commands.

## What a skill is

A skill is a versioned knowledge artifact — a canonical **`skill.toml`** file —
that an agent can load at runtime to learn *how* to do something (coding
conventions, debugging methodology, summarization style). Skills are knowledge,
not executable tools: loading one returns prose the model reads.

TOML is the only format Oxagen accepts for agents, skills, and slash commands.
Markdown-with-frontmatter is not a supported authoring format anywhere in the
runtime; the sole component that still reads it is the import engine, which
converts foreign artifacts into canonical TOML. See
[`docs/guides/import-agent-artifacts.md`](../guides/import-agent-artifacts.md).

Design remains **filesystem-first with DB augmentation** (ADR-008,
`docs/adr/ADR-008-skills-filesystem-first.md`) — that ADR predates the TOML
cutover and describes the original Markdown-file layout; the principle holds, the
file format does not. Built-ins live as `skill.toml` bundles under source
control; tenant-authored skills live in Postgres and shadow built-ins on slug
collision.

## Canonical artifact formats

All three artifact kinds share a strict, closed schema
(`packages/agent-artifacts/src/schemas.ts`). Unknown keys are rejected, names are
kebab-case, and capability slugs are ADR-025 verb-first snake_case.

### Skill — `skills/<name>/skill.toml`

A skill is a *directory bundle*: a `skill.toml` manifest plus any supporting
files it references.

```toml
schema_version = 1
kind = "skill"
name = "debugging"
description = "Reproduce, read the real error, narrow down, fix the root cause, land a regression test."
instructions = """
# Debugging

Reproduce the failure before changing anything...
"""
references = ["checklist.md"]

[metadata]
weight = "high"
category = "engineering"
```

| Field | Required | Notes |
| --- | --- | --- |
| `schema_version` | ✓ | Literal `1`. |
| `kind` | ✓ | Literal `"skill"`. |
| `name` | ✓ | Kebab-case slug. |
| `description` | ✓ | One-sentence matcher used to decide when to load it. |
| `instructions` | ✓ | The body the model reads. |
| `references` | | Bundle-relative paths. Must stay inside the bundle — absolute paths and `..` are rejected. |
| `metadata` | | Flat string→string map (e.g. `weight`, `category`). |

### Agent — `agents/<name>.toml`

```toml
schema_version = 1
kind = "agent"
name = "code-reviewer"
description = "Reviews changed code for correctness and convention fit."
model = "balanced"
developer_instructions = """
Review the diff. Lead with the highest-severity finding...
"""
tools = ["read_file", "grep", "glob"]
skills = ["coding", "debugging"]
unresolved_tools = []
```

| Field | Required | Notes |
| --- | --- | --- |
| `developer_instructions` | ✓ | The agent's operating instructions. |
| `model` | | Portable tier — `fast`, `balanced`, or `powerful`. |
| `tools` | | Canonical Oxagen capability slugs. |
| `skills` | | Skill slugs to make loadable. |
| `unresolved_tools` | | Tool names that could not be mapped. **A non-empty value makes the agent non-executable** — loaders exclude it with an `artifact_needs_review` diagnostic until a human resolves each entry. |
| `input` / `output` | | `{ schema = "relative/path.json" }`, bundle-contained. |
| `driver` | | Deterministic lifecycle configuration (see the lifecycle guide). |

### Slash command — `commands/<name>.toml`

```toml
schema_version = 1
kind = "command"
name = "release-notes"
description = "Draft release notes from the commits since the last tag."
argument_hint = "<since-tag>"
prompt = """
Summarize the changes since {{arg}}...
"""
agent = "code-reviewer"
model = "fast"
```

`agent` and `model` are optional; `agent` names an agent artifact to run the
prompt through.

### Determinism

`serializeArtifactToml` emits fields in schema-owned order, LF line endings, and
exactly one trailing newline, so the same artifact always produces byte-identical
TOML. `hashArtifact` hashes those UTF-8 bytes with SHA-256; `hashCanonicalJson`
hashes structured values through RFC 8785. This is what makes artifact hashes
comparable across machines and import reruns idempotent.

## Out-of-the-box skills (14)

Shipped as `skill.toml` bundles under `packages/skills/skills/<slug>/` and
embedded into the package at build time by `scripts/embed-skills.ts`. Seeded into
Postgres by `pnpm db:seed-skills` (`tools/scripts/seed-skills.ts`, dry-run by
default; `-- --apply` writes per-workspace rows). The shipped skills are
**generic customer starters** — they teach an agent good general practice, not
Oxagen's internal monorepo conventions, so a customer can use or adapt them
immediately:

| Slug | Category | Purpose |
|---|---|---|
| `coding` | engineering | Understand before writing, match the codebase, small reviewable changes, test what you write, security and performance defaults |
| `debugging` | engineering | Reproduce → read the real error → narrow down → fix the root cause not the symptom → land a regression test |
| `ci-fixer` | engineering | Diagnose and repair failing CI runs |
| `summarization` | writing | Lead with the conclusion, anchor evidence to sources, never drop a pending action, compaction rules |
| `brand-voice-design` | design | Apply brand voice and visual design guidance |
| `skill-builder` | meta | How to author a new skill — artifact shape, body structure, when a skill is worth writing, keeping it generic and token-efficient |
| `agent-builder` | meta | How the in-app agent designs, configures, and deploys agents |
| `create-agent` | meta | End-to-end agent creation walkthrough |
| `entity-extractor` | knowledge-graph | Extract entities from source content |
| `entity-resolver` | knowledge-graph | Resolve and deduplicate extracted entities |
| `relationship-extractor` | knowledge-graph | Extract relationships between entities |
| `graph-ingestion` | knowledge-graph | Drive the ingestion pipeline into the graph |
| `iam-rbac-setup` | security | Configure IAM roles and RBAC policy |
| `swarm-research` | research | Fan out multi-source research and synthesize |

Built-ins are stamped with sentinel nil-UUID org/workspace IDs to mark them
platform-global.

## Storage

- `agent.skills` (`packages/database/src/schema/agent.ts:63`) — identity:
  `(workspace_id, slug)` unique; `source` = `builtin` | `tenant`; `enabled`
  toggle; org/workspace scoped; soft-delete.
- `agent.skill_versions` (`:210`) — immutable INSERT-only version snapshots
  (`version_number`, `is_latest` partial-unique, `parent_version_id` lineage,
  `body` holding the **canonical `skill.toml` text**, `references_payload`
  jsonb, `checksum` SHA-256 over `body`). Versioning exists for replay
  determinism.
- `packages/skills/` — zero-DB-dependency loader/registry. `createSkillRegistry`
  merges filesystem + DB rows (tenant wins slug collisions), caches until
  `refresh()`. The loader parses TOML through `@oxagen/agent-artifacts` and
  resolves the artifact's explicit `references` list; there is no implicit
  `## References` section scan.

Managed TOML in Postgres is canonical for workspace skills; the relational
columns are transactional projections of it. Every write path validates the TOML
through `canonicalizeSkillArtifact`
(`packages/handlers/src/skill-artifact.ts`) **before** any database write, so a
row can never hold content the runtime cannot parse.

## Capabilities (the entire runtime surface)

| Capability | Surfaces | What it does |
|---|---|---|
| `agent.skill.list` | api, mcp, agent | List workspace skills (slug, name, description, source, version); optional substring filter |
| `agent.skill.load` | api, mcp, agent | Load a skill body by slug + semver-ish constraint (`3`, `^2`, `~2`, latest); extracts referenced capability slugs; non-blocking dependency validation |
| `skill.workspace.list` | api, mcp | Admin-facing list (id, name, description, enabled) |

These three are read-only, risk `low`, no approval. Handlers:
`packages/agent/src/handlers/agent.skill.{list,load}.ts`,
`packages/handlers/src/skill.workspace.list.ts`.

The tenant authoring surface now exists as well — `skill.create`, `skill.edit`,
`skill.enable`, `skill.author`, `revise_skill`, `skill.draft`,
`skill.workspace.install`, `skill.export`, `skill.metrics.read`, and the
`skill.version.{list,get,upload,activate}` family. All of them speak canonical
TOML:

- **Request/response field is `content`**, carrying `skill.toml` text.
- **Parsed projection is `artifact`** (a validated `SkillArtifact`). The
  `frontmatter` field and the Markdown-era body field are both gone.
- **`skill.export` returns `<slug>.toml`.**

See `docs/capabilities/skill.*.md` for per-capability input/output tables.

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
| Create / edit / version | ✓ | ✓ | ✓ | ✗ | ✓ (`skill.create`, `skill.author`) |
| Enable / disable | ✓ | ✓ | ✓ | ✗ | ✓ |
| Export as `<slug>.toml` | ✓ | ✓ | ✓ | ✗ | ✗ |
| Pin skills for a session | ✗ | ✗ | ✗ | ✗ | ✗ |

## Improvement opportunities

Ordered by leverage:

1. **Prompt the habit (cheapest, highest impact).** Inject a one-line-per-skill
   index (slug + description, ~15 tokens each) into `chatSystemPrompt` with an
   instruction to `agent.skill.load` when relevant. This is the
   metadata-first / progressive-disclosure pattern Claude Code itself uses, and
   it converts dormant infrastructure into behavior for ~50 cached tokens.
2. **CLI authoring parity.** The authoring surface shipped (create/edit/version/
   enable/export across API, MCP, and the app), but the CLI still has no write
   commands and no `agent.skill.load`. Closing that gap would let a workspace be
   driven entirely from the terminal, and pairs naturally with
   `oxagen import artifacts` as the on-ramp.
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
