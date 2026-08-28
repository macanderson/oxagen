# Workspace Config (.oxagen)

Archived spec & plan — status: partially shipped (audited 2026-07-03).

> **Status: Partially shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The Workspace Config feature is partially shipped with phases 1-5 of the planned 7-phase implementation complete. All core infrastructure is delivered: the 4-scope governed config schema, resolution engine with locking/governance, CLI command surface (init/get/set/add/remove/explain/build/lint/doctor/pull), multi-scope indexer, and agent system-prompt injection. The `/config` REPL TUI panel enables interactive browsing and editing. What remains unimplemented are phase 6 (the `/settings` interview agent for guided configuration via scan + web research) and phase 7 (web app UI for managing org/user scopes).

**Implementation evidence**

- apps/cli/src/config/schema.ts — Zod schema with all sections (vision, commands, worktrees, languages, vcs, issues, database, sources, consolidated)
- apps/cli/src/config/resolve.ts — 4-scope resolver (ORG > USER > WORKSPACE > REPO) with governance/locking enforcement
- apps/cli/src/commands/config.ts — 10 subcommands: init, get, set, add, remove, explain, build, lint, doctor, pull
- apps/cli/src/config/indexer.ts — Scanner building consolidated capability index across sources at both scopes
- apps/cli/src/agent/project-context.ts — Resolver feeds workspace config into agent system prompt (vision, enforced rules, commands)
- apps/cli/src/repl/config-panel.tsx — TUI panel for `/config` slash command with keyboard navigation
- apps/cli/src/config/doctor.ts — Offline diagnostics scanning config tiers and reporting shadowing issues
- apps/cli/src/config/__tests__/ — 7 test files covering schema, resolver, indexer, write, doctor (14k+ LOC)
- .oxagen/workspace.json — Living example with identity fields (backward-compatible with existing WorkspaceLink)
- docs/specs/oxagen-workspace-config/design.md §10 — Phased build plan documenting phases 1-5 as delivered

**Known gaps at time of archive**

- Phase 6: `/settings` interview agent — config-builder agent with scan + websearch/webfetch tools + scoped write tools for guided config via user interview
- Phase 7: Web app surface — UI in /settings pages for managing org (managed.json) and user scopes, bidirectional sync via `oxagen config pull`
- Web API endpoints for workspace config CRUD (workspace.json editing via API for web app)

**Source documents** (archived verbatim below)

- `docs/specs/oxagen-workspace-config/design.md`

## Spec — `design.md`

## Oxagen Workspace Config — a structured, governed CLAUDE.md replacement

**Status:** design · **Owner:** Mac Anderson · **Surface:** CLI + web + agent engine

### 1. Goal

Replace prose `CLAUDE.md` with a **structured, machine-reliable, multi-scope, governed**
configuration that the CLI agent, the web agent, and humans all read and write. Instead of
the agent grepping `package.json` for the test command or inferring conventions from prose, it
reads *reliable points of reference*: the exact commands, the branch/commit/PR conventions, the
per-language rules, the project's vision, the tooling it has available. The same config powers
the web app because it is keyed to the Oxagen workspace identity — **it works everywhere Oxagen
works.**

Non-goals: replacing `settings.json` (machine/tool settings — model, permissions, hooks — stay
separate); replacing the code graph (this is a *config + tooling* index, complementary to the
*code* index).

### 2. Files & scopes

The filename **is** the scope, and each maps to an entity the web app already understands.

| Scope | File | Written by | Authority |
|---|---|---|---|
| **ORG** | `~/.oxagen/managed.json` | org only (provisioned onto the machine, MDM-style) | highest — every entry implicitly `locked`, dev cannot override |
| **USER** | `~/.oxagen/user.json` | dev (local) + web (profile) | personal global |
| **WORKSPACE** | `<ws>/.oxagen/workspace.json` | dev (local) + web (workspace) | project config **+ the existing web-workspace identity** |
| **REPO** | `<repo>/.oxagen/repo.json` | dev (local) | per-repo, only when a workspace spans multiple repos (collapses into workspace when 1:1) |

`workspace.json` already exists today as the tenant **link** (`WorkspaceLink`:
`orgSlug/orgId/workspaceSlug/workspaceId/repos/linkedAt`). We **extend** it — identity stays,
config sections are added — so one file = one web workspace, identity + config together.
`managed.json` is read-only to the CLI.

### 3. Resolution semantics

Reuses the merge engine already in `apps/cli/src/settings/resolve.ts` (scalars: higher wins;
lists: concat + dedupe), extended to 4 scopes with governance:

- **Preferences / scalars** (commands, packageManagers, branch prefix, attribution): **most-specific
  wins** — `REPO > WORKSPACE > USER > ORG` — for developer ergonomics.
- **Lists** (language items, sources): **accumulate** — union by `id` across all scopes.
- **Governance**: any entry can be `locked: true`; everything in `managed.json` is implicitly
  locked. A locked entry cannot be overridden or removed by a lower scope; **locked conflicts
  resolve `ORG > USER > WORKSPACE > REPO`** (the stated precedence, enforced).
- `oxagen config explain <path>` reports the winning scope and *"locked by managed.json (org)."*

### 4. Schema (`workspace.json`, all sections)

```jsonc
{
  "$schema": "https://schemas.oxagen.sh/workspace.json",
  "version": 1,

  // identity — EXISTING (the web-workspace binding), unchanged
  "org":       { "slug": "…", "id": "…", "name": "…" },
  "workspace": { "slug": "…", "id": "…", "name": "…" },
  "repos":     [{ "provider": "github", "fullName": "org/repo" }],

  // vision — anchors agents, prevents project drift
  "vision": { "statement": "…", "goals": ["…"], "nonGoals": ["…"], "principles": ["…"] },

  // commands — every important script, grouped by intent; the agent picks deterministically
  "commands": {
    "dev":   [{ "run": "pnpm dev --filter @oxagen/app", "description": "web app on :3000", "background": true }],
    "build": [], "test": [], "lint": [], "typecheck": [], "migrate": [], "release": [], "gate": [],
    "custom": { "kill": [{ "run": "pnpm kill" }] }
  },

  // worktrees — compose isolated worktrees efficiently (seed non-tracked files git won't carry)
  "worktrees": {
    "namePattern": "oxagen-{slug}",
    "seed":  { "include": [".env", ".env.local", "creds.json", ".oxagen/settings.json"],
               "exclude": ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.turbo/**"] },
    "link":  ["node_modules", ".pnpm-store"],          // symlink heavy dirs instead of copying
    "setup": [{ "run": "pnpm i --no-frozen-lockfile", "description": "sync deps in the new worktree" }],
    "cleanup": "auto"
  },

  "packageManagers": { "primary": "pnpm", "node": "pnpm@9", "python": "uv" },

  // languages — CODE and NATURAL languages side by side; english/es hold marketing + localization voice
  "languages": {
    "typescript": { "items": [
      { "id": "no-any", "kind": "rule", "text": "No `any`.", "enforced": true, "origin": "manual" },
      { "id": "ui-import", "kind": "convention", "doc": "docs/ui-imports.md", "origin": "scan", "source": "CLAUDE.md" }
    ]},
    "english": {                                        // natural language = product / marketing voice
      "voice": { "tone": "confident, concise, technical", "audience": "senior engineers",
                 "readingLevel": "grade 9", "person": "second",
                 "banned": ["leverage", "seamless"], "glossary": { "knowledge graph": "two words, lowercase" } },
      "items": [ { "id": "oxford", "kind": "convention", "text": "Oxford comma.", "origin": "manual" },
                 { "id": "rust-errors", "kind": "convention", "text": "…", "origin": "research",
                   "source": "https://rust-lang.github.io/api-guidelines/", "confidence": 0.86 } ]
    },
    "es": { "voice": { "tone": "…", "formality": "usted" }, "items": [] }
  },

  // vcs — branch / commit / PR conventions + configurable attribution
  "vcs": {
    "commit":      { "convention": "conventional",
                     "attribution": { "coAuthors": ["Claude <noreply@anthropic.com>"],
                                      "trailers": { "Claude-Session": "{sessionUrl}" }, "signoff": false } },
    "pullRequest": { "template": ".github/pull_request_template.md", "base": "main",
                     "attribution": { "footer": "🤖 Generated with Oxagen", "assignees": ["mac@oxagen.ai"] } },
    "branch":      { "convention": "{type}/{slug}",
                     "prefixes": { "feature": "feat/", "fix": "fix/", "chore": "chore/" }, "protected": ["main"] }
  },

  // issues — link to the project's tracker, GitHub or Linear
  "issues": { "provider": "linear",
              "linear": { "team": "oxagen-v2", "project": "…", "apiKeyEnv": "LINEAR_API_KEY" },
              "github": { "repo": "org/repo" }, "linkFormat": "https://linear.app/…/{id}" },

  // database / schema preferences
  "database": { "migrations": { "dir": "packages/database/migrations", "naming": "…" },
                "release": { "script": "pnpm release:patch" } },

  // sources — WHERE to index from, at BOTH scopes
  "sources": {
    "scan": ["workspace", "user"],
    "workspace": { "conventions": ["CLAUDE.md","AGENTS.md",".cursorrules",".cursor/rules/**"],
                   "skills": [".agents/skills",".claude/skills",".oxagen/skills"],
                   "agents": [".claude/agents",".oxagen/agents",".cursor/agents"],
                   "mcp": [".mcp.json",".cursor/mcp.json",".oxagen/settings.json"],
                   "commands": [".claude/commands",".oxagen/commands"], "tools": [".oxagen/tools"] },
    "user": { "conventions": ["~/.claude/CLAUDE.md"], "skills": ["~/.claude/skills","~/.oxagen/skills"],
              "agents": ["~/.claude/agents","~/.oxagen/agents"], "mcp": ["~/.claude.json","~/.cursor/mcp.json"],
              "commands": ["~/.claude/commands"], "tools": ["~/.oxagen/tools"] }
  },

  // consolidated — GENERATED by `oxagen config build` (read-only, scope-attributed, deduped)
  "consolidated": {
    "generatedAt": "…",
    "skills":      [{ "name": "coss-ui", "scope": "workspace", "path": ".agents/skills/coss-ui", "description": "…" }],
    "agents":      [{ "name": "break-fix", "scope": "user", "path": "~/.claude/agents/break-fix.md", "tools": ["Read","Edit","Bash"] }],
    "mcpServers":  [{ "name": "linear", "scope": "workspace", "transport": "stdio", "tools": ["create_issue"] }],
    "commands":    [{ "name": "ci-green", "scope": "workspace", "path": ".oxagen/commands/ci-green.md" }],
    "customTools": [{ "name": "…", "scope": "user", "schema": "…" }],
    "conventionsByLanguage": { "typescript": [] },
    "sourceFiles": [{ "path": "CLAUDE.md", "scope": "workspace", "kind": "conventions" }]
  }
}
```

**Item shape** (a language `item` or a derived convention):
`{ id, kind: rule|preference|policy|convention|reference, text?|doc?, enforced?, locked?, scope?, origin: manual|scan|research, source?, confidence? }`.
`origin`/`source` give provenance so `explain` can say *"from researching the Rust API guidelines."*

### 5. Consolidation / indexing (`oxagen config build`)

Scans the `sources` at both scopes and builds the read-only `consolidated` index: every
**skill, custom agent definition, MCP server (+ the tools it exposes), command, custom tool**,
and the `CLAUDE.md`/`.cursorrules`/`AGENTS.md` conventions — across Claude Code, Cursor, and
Oxagen. Deduped with precedence (workspace beats user on name clash; both recorded), each entry
scope- and source-attributed. Idempotent; human-authored sections untouched. Built on demand +
cached like the code graph; refreshed on change. This is a **tooling index** that complements
the code graph — the agent knows its full capability surface without re-scanning.

### 6. `/settings` — an interview, not a form

`/settings` (REPL) and `oxagen settings` (CLI) launch a **config-builder agent** running the
engine loop with a specialized prompt and a purpose-built toolset:

- **scan tools** — read `CLAUDE.md`/`.cursorrules`/`.cursor`/`.agents`/skills/MCP/`package.json` → propose derived config.
- **web tools** — `websearch` + `webfetch`, so it derives conventions from *online* sources, not just local files. e.g. *"research Rust best practices and pick what fits a CLI tool"* → websearch → webfetch top authoritative sources → assess fit against what the repo already does → propose a curated, **cited** set → user approves → written to the chosen scope.
- **config-write tools** — `setVision`, `addCommand`, `addLanguageItem`, `setVoice`, `setWorktreeSeed`, etc., scoped to `--workspace` or `--user`. Reads `managed.json` to show what is locked; never writes it.

The flow interviews the user (vision, commands, languages, voice, worktree seeds), proposing
derived defaults from the scan + web research and confirming each. First-run does a full pass;
later runs are targeted edits.

### 7. CLI surface

`oxagen settings` / `/settings` (interview) · `oxagen config init | build | get <path> | set <path> <val> --scope … | add <lang> <kind> "…" | remove <id> | explain <path> | lint | pull`. REPL slash: `/settings`, `/config`, `/rule`, `/vision`.

### 8. Web / org

ORG + USER scopes are edited in the web app and delivered locally: `user.json` syncs
bidirectionally (`oxagen config pull`, like `env:pull`); `managed.json` is org-provisioned and
locked. Because `workspace.json` carries `workspaceId`, the web app reads/writes the same
logical record.

### 9. Agent consumption

The resolved config becomes a **structured `projectContext`**: `vision` → an anchor block;
`enforced` rules → the hard-rules section; `commands` → the agent runs the *right* dev/test
script instead of guessing; `vcs` → correct branch names, commit attribution, PR footers;
`worktrees.seed` → best-of-N and the fleet bring up working worktrees; `consolidated` → the
agent knows its skills/agents/MCP-tools/commands. Pairs with the graph-first mandate: reliable
*code* references (code graph) + reliable *config* references (this).

### 10. Build phasing

1. Spec (this doc).
2. Schema + types — zod for all sections; `WorkspaceLink` → `WorkspaceConfig` (back-compatible).
3. Resolver — extend `settings/resolve.ts` to 4 scopes + `locked`/managed authority + list-accumulate; `explain`.
4. `oxagen config` commands + feed resolved config into `projectContext`.
5. Indexer — `oxagen config build` multi-scope consolidation.
6. `/settings` interview agent — scan + `websearch`/`webfetch` (wire web tools if absent) + scoped write tools.
7. Web app surface for org (`managed.json`) + user scopes.

### 11. Open questions

- `websearch`/`webfetch` tools: confirm whether they exist in the CLI toolset or need adding (blocks phase 6).
- Are natural-language/voice prefs org-lockable (brand consistency)? Default: **yes, lockable**.
- Does `repo.json` earn its place now, or defer until a multi-repo workspace exists? Default: **schema-reserve it, implement later.**

