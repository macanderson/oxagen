/**
 * schema.ts — The `workspace.json` / `repo.json` / `user.json` / `managed.json`
 * schema that backs Oxagen Workspace Config (see
 * docs/specs/oxagen-workspace-config/design.md, §4).
 *
 * This is a *structured, governed* replacement for prose `CLAUDE.md`: the
 * exact commands, vision, per-language rules, VCS/PR conventions, and tooling
 * index the CLI agent, the web agent, and humans all read and write. One
 * schema, resolved across four scopes (see resolve.ts):
 *
 *   - ORG       ~/.oxagen/managed.json   org-provisioned, always locked
 *   - USER      ~/.oxagen/user.json      personal global preferences
 *   - WORKSPACE <ws>/.oxagen/workspace.json  project config + web-workspace identity
 *   - REPO      <repo>/.oxagen/repo.json     per-repo, only for multi-repo workspaces
 *
 * Identity fields (orgSlug/orgId/orgName/workspaceSlug/workspaceId/
 * workspaceName/repos/linkedAt) are the EXISTING `WorkspaceLink` shape from
 * `lib/workspace-link.ts`, kept flat and unchanged so every `workspace.json`
 * written by today's `oxagen init` already validates as a minimal
 * (identity-only) `WorkspaceConfig` — no migration needed. design.md §4
 * sketches identity as nested (`org: {slug,id,name}`, `workspace: {...}`);
 * we deliberately keep the flat shape instead, since back-compat with every
 * already-linked repo takes priority over the sketch, and `workspace-link.ts`
 * is left untouched (see design.md §10 build-phasing note: "WorkspaceLink →
 * WorkspaceConfig (back-compatible)").
 *
 * Every section below is optional so a minimal (identity-only, or even
 * empty) file validates — `oxagen init` writes identity today; later CLI
 * commands (`oxagen config set/add/…`) fill in sections incrementally.
 *
 * `locked` (top-level, dotted paths) lets ANY scope declare that its value at
 * a given path cannot be overridden by a less-authoritative scope — see
 * resolve.ts for how this and per-item `locked`/`enforced` flags are enforced.
 * Everything in `managed.json` (ORG) is *implicitly* locked regardless of
 * this field — that file is read-only to the CLI.
 */
import { z } from "zod";

// ── Shared enums ──────────────────────────────────────────────────────────────

/**
 * The four config scopes. This array's order carries no precedence meaning —
 * `CONFIG_SCOPE_ORDER` in resolve.ts is the single source of truth for
 * authority and specificity ordering.
 */
export const CONFIG_SCOPES = ["org", "user", "workspace", "repo"] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];
export const configScopeSchema = z.enum(CONFIG_SCOPES);

export const LANGUAGE_ITEM_KINDS = [
  "rule",
  "preference",
  "policy",
  "convention",
  "reference",
] as const;
export type LanguageItemKind = (typeof LANGUAGE_ITEM_KINDS)[number];

export const LANGUAGE_ITEM_ORIGINS = ["manual", "scan", "research"] as const;
export type LanguageItemOrigin = (typeof LANGUAGE_ITEM_ORIGINS)[number];

// ── Identity (EXISTING WorkspaceLink shape — see file header) ─────────────────

export const repoRefSchema = z.object({
  provider: z.literal("github"),
  fullName: z.string(),
});
export type RepoRef = z.infer<typeof repoRefSchema>;

// ── Vision ──────────────────────────────────────────────────────────────────

export const visionSchema = z
  .object({
    statement: z.string().optional(),
    goals: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    principles: z.array(z.string()).optional(),
  })
  .passthrough();
export type VisionConfig = z.infer<typeof visionSchema>;

// ── Commands ────────────────────────────────────────────────────────────────

export const commandEntrySchema = z.object({
  run: z.string().min(1),
  description: z.string().optional(),
  /** True for long-running processes (dev servers) the agent should launch detached. */
  background: z.boolean().optional(),
});
export type CommandEntry = z.infer<typeof commandEntrySchema>;

export const commandsSchema = z
  .object({
    dev: z.array(commandEntrySchema).optional(),
    build: z.array(commandEntrySchema).optional(),
    test: z.array(commandEntrySchema).optional(),
    lint: z.array(commandEntrySchema).optional(),
    typecheck: z.array(commandEntrySchema).optional(),
    migrate: z.array(commandEntrySchema).optional(),
    release: z.array(commandEntrySchema).optional(),
    gate: z.array(commandEntrySchema).optional(),
    /** Anything that doesn't fit a standard intent, keyed by name (e.g. "kill"). */
    custom: z.record(z.array(commandEntrySchema)).optional(),
  })
  .passthrough();
export type CommandsConfig = z.infer<typeof commandsSchema>;

// ── Worktrees ───────────────────────────────────────────────────────────────

export const worktreeSeedSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});
export type WorktreeSeed = z.infer<typeof worktreeSeedSchema>;

export const worktreesSchema = z
  .object({
    namePattern: z.string().optional(),
    /** Non-tracked files (env, creds) to copy into a freshly composed worktree. */
    seed: worktreeSeedSchema.optional(),
    /** Heavy dirs symlinked into a new worktree instead of copied/reinstalled. */
    link: z.array(z.string()).optional(),
    setup: z.array(commandEntrySchema).optional(),
    /** Whether a finished worktree is torn down automatically or left for the developer. */
    cleanup: z.enum(["auto", "manual"]).optional(),
  })
  .passthrough();
export type WorktreesConfig = z.infer<typeof worktreesSchema>;

// ── Package managers ────────────────────────────────────────────────────────

export const packageManagersSchema = z
  .object({
    primary: z.string().optional(),
    node: z.string().optional(),
    python: z.string().optional(),
  })
  // .passthrough so additional ecosystems (go, rust, ...) can be added without a schema bump.
  .passthrough();
export type PackageManagersConfig = z.infer<typeof packageManagersSchema>;

// ── Languages (code AND natural language, side by side) ───────────────────────

/**
 * Natural-language voice/style guide for a language entry keyed by a human
 * language (e.g. "english", "es") rather than a programming language.
 * Per design.md §11, voice prefs default to org-lockable for brand
 * consistency — enforced the same way as any other leaf path (resolve.ts).
 */
export const languageVoiceSchema = z
  .object({
    tone: z.string().optional(),
    audience: z.string().optional(),
    readingLevel: z.string().optional(),
    person: z.string().optional(),
    /** Formality register (e.g. "usted" for es) — natural-language-specific. */
    formality: z.string().optional(),
    banned: z.array(z.string()).optional(),
    glossary: z.record(z.string()).optional(),
  })
  .passthrough();
export type LanguageVoice = z.infer<typeof languageVoiceSchema>;

/**
 * A single rule/preference/policy/convention/reference, either hand-authored
 * or derived by the config-builder agent (scan or web research). `id` is the
 * stable key the resolver unions items on across scopes (§3); `origin` +
 * `source` give provenance so `explain`/`consolidated` can say *"from
 * researching the Rust API guidelines."*
 */
export const languageItemSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(LANGUAGE_ITEM_KINDS),
    /** Inline rule text. Either `text` or `doc` (or both) is typically set. */
    text: z.string().optional(),
    /** Path/URL to a doc that has the full detail (e.g. "docs/ui-imports.md"). */
    doc: z.string().optional(),
    /** Must be followed — surfaces in the agent's hard-rules section. */
    enforced: z.boolean().optional(),
    /** Cannot be overridden or removed by a less-authoritative scope (§3). */
    locked: z.boolean().optional(),
    /** Scope this item is pinned to, when meaningfully different from where it's declared. */
    scope: configScopeSchema.optional(),
    origin: z.enum(LANGUAGE_ITEM_ORIGINS),
    /** File path / URL the item was derived from (scan/research provenance). */
    source: z.string().optional(),
    /** 0–1 confidence score, typically set for `origin: "research"` items. */
    confidence: z.number().min(0).max(1).optional(),
  })
  .passthrough();
export type LanguageItem = z.infer<typeof languageItemSchema>;

export const languageEntrySchema = z.object({
  voice: languageVoiceSchema.optional(),
  items: z.array(languageItemSchema).optional(),
});
export type LanguageEntry = z.infer<typeof languageEntrySchema>;

/** Keyed by language name — "typescript", "python", "english", "es", ... */
export const languagesSchema = z.record(languageEntrySchema);
export type LanguagesConfig = z.infer<typeof languagesSchema>;

// ── VCS (branch / commit / PR conventions + attribution) ──────────────────────

export const attributionSchema = z
  .object({
    coAuthors: z.array(z.string()).optional(),
    trailers: z.record(z.string()).optional(),
    signoff: z.boolean().optional(),
    footer: z.string().optional(),
    assignees: z.array(z.string()).optional(),
  })
  .passthrough();
export type Attribution = z.infer<typeof attributionSchema>;

export const vcsCommitSchema = z
  .object({
    convention: z.string().optional(),
    attribution: attributionSchema.optional(),
  })
  .passthrough();

export const vcsPullRequestSchema = z
  .object({
    template: z.string().optional(),
    base: z.string().optional(),
    attribution: attributionSchema.optional(),
  })
  .passthrough();

export const vcsBranchSchema = z
  .object({
    convention: z.string().optional(),
    prefixes: z.record(z.string()).optional(),
    protected: z.array(z.string()).optional(),
  })
  .passthrough();

export const vcsSchema = z
  .object({
    commit: vcsCommitSchema.optional(),
    pullRequest: vcsPullRequestSchema.optional(),
    branch: vcsBranchSchema.optional(),
  })
  .passthrough();
export type VcsConfig = z.infer<typeof vcsSchema>;

// ── Issues (tracker link) ──────────────────────────────────────────────────────

export const linearIssuesConfigSchema = z
  .object({
    team: z.string().optional(),
    project: z.string().optional(),
    apiKeyEnv: z.string().optional(),
  })
  .passthrough();

export const githubIssuesConfigSchema = z
  .object({
    repo: z.string().optional(),
  })
  .passthrough();

export const issuesSchema = z
  .object({
    provider: z.enum(["linear", "github"]).optional(),
    linear: linearIssuesConfigSchema.optional(),
    github: githubIssuesConfigSchema.optional(),
    linkFormat: z.string().optional(),
  })
  .passthrough();
export type IssuesConfig = z.infer<typeof issuesSchema>;

// ── Database / schema preferences ──────────────────────────────────────────────

export const databaseSchema = z
  .object({
    migrations: z
      .object({
        dir: z.string().optional(),
        naming: z.string().optional(),
      })
      .passthrough()
      .optional(),
    release: z
      .object({
        script: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type DatabaseConfig = z.infer<typeof databaseSchema>;

// ── Sources (WHERE `oxagen config build` indexes from) ─────────────────────────

export const sourceCategoriesSchema = z
  .object({
    conventions: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
    mcp: z.array(z.string()).optional(),
    commands: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();
export type SourceCategories = z.infer<typeof sourceCategoriesSchema>;

export const sourcesSchema = z
  .object({
    scan: z.array(z.enum(["workspace", "user"])).optional(),
    workspace: sourceCategoriesSchema.optional(),
    user: sourceCategoriesSchema.optional(),
  })
  .passthrough();
export type SourcesConfig = z.infer<typeof sourcesSchema>;

// ── Consolidated (GENERATED by `oxagen config build` — read-only) ──────────────

export const consolidatedSkillSchema = z
  .object({
    name: z.string(),
    scope: configScopeSchema,
    path: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

export const consolidatedAgentSchema = z
  .object({
    name: z.string(),
    scope: configScopeSchema,
    path: z.string(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();

export const consolidatedMcpServerSchema = z
  .object({
    name: z.string(),
    scope: configScopeSchema,
    transport: z.string().optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();

export const consolidatedCommandSchema = z
  .object({
    name: z.string(),
    scope: configScopeSchema,
    path: z.string().optional(),
  })
  .passthrough();

export const consolidatedCustomToolSchema = z
  .object({
    name: z.string(),
    scope: configScopeSchema,
    schema: z.unknown().optional(),
  })
  .passthrough();

export const consolidatedSourceFileSchema = z
  .object({
    path: z.string(),
    scope: configScopeSchema,
    kind: z.string().optional(),
  })
  .passthrough();

export const consolidatedSchema = z
  .object({
    generatedAt: z.string().optional(),
    skills: z.array(consolidatedSkillSchema).optional(),
    agents: z.array(consolidatedAgentSchema).optional(),
    mcpServers: z.array(consolidatedMcpServerSchema).optional(),
    commands: z.array(consolidatedCommandSchema).optional(),
    customTools: z.array(consolidatedCustomToolSchema).optional(),
    conventionsByLanguage: z.record(z.array(z.string())).optional(),
    sourceFiles: z.array(consolidatedSourceFileSchema).optional(),
  })
  .passthrough();
export type ConsolidatedConfig = z.infer<typeof consolidatedSchema>;

// ── Top-level WorkspaceConfig ───────────────────────────────────────────────────

export const workspaceConfigSchema = z
  .object({
    /** Optional JSON-Schema reference for editor autocompletion. */
    $schema: z.string().optional(),
    version: z.number().int().optional(),

    // Identity — flat, matches lib/workspace-link.ts's WorkspaceLink exactly.
    // All optional here (unlike WorkspaceLink) because managed.json/user.json
    // legitimately carry zero workspace identity — only workspace.json (and
    // optionally repo.json) are expected to be fully populated.
    orgSlug: z.string().optional(),
    orgId: z.string().optional(),
    orgName: z.string().optional(),
    workspaceSlug: z.string().optional(),
    workspaceId: z.string().optional(),
    workspaceName: z.string().optional(),
    repos: z.array(repoRefSchema).optional(),
    linkedAt: z.string().optional(),

    vision: visionSchema.optional(),
    commands: commandsSchema.optional(),
    worktrees: worktreesSchema.optional(),
    packageManagers: packageManagersSchema.optional(),
    languages: languagesSchema.optional(),
    vcs: vcsSchema.optional(),
    issues: issuesSchema.optional(),
    database: databaseSchema.optional(),
    sources: sourcesSchema.optional(),
    /** Generated by `oxagen config build` (phase 5) — read-only from the CLI's POV. */
    consolidated: consolidatedSchema.optional(),

    /**
     * Dotted paths (e.g. "packageManagers.primary", "vcs.branch") that THIS
     * scope's values are locked at — a less-authoritative scope cannot
     * override or remove them (resolve.ts). Locking a path also locks every
     * path beneath it (locking "vcs" locks "vcs.branch.protected" too).
     * Every path in managed.json is implicitly locked regardless of this
     * list — ORG doesn't need to (and can't usefully) declare it.
     */
    locked: z.array(z.string()).optional(),
  })
  // Forward-compatible: sections that land in later build phases (§10) may
  // already be present in a user's file; pass them through rather than
  // failing validation, matching settings/schema.ts's convention.
  .passthrough()
  // Dead-key guard (see RUNTIME_DEAD_KEYS at the foot of this file): reject
  // the four CLI runtime/session keys specifically, while every other
  // passthrough key (including genuinely unknown future sections) still
  // validates fine. The list is read at parse time, not at definition time,
  // so declaring it below this schema is safe.
  .superRefine((doc, ctx) => {
    for (const key of RUNTIME_DEAD_KEYS) {
      if (key in doc) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message:
            `"${key}" is a CLI runtime setting (see \`oxagen config ${RUNTIME_DEAD_KEY_REDIRECT[key]}\`), not a ` +
            `Workspace Config field — nothing reads it from workspace/user/repo/managed config, so writing it ` +
            `here would be a silent no-op.`,
        });
      }
    }
  });

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

// ── Dead-key guard ────────────────────────────────────────────────────────────

/**
 * Top-level keys that belong to the CLI *runtime* credential/session store
 * (`~/.config/oxagen/config.json`, see `lib/config.ts`'s `CliConfig`) or to
 * `settings.json` (`../settings/schema.ts`) — NOT to this Workspace Config
 * schema. Nothing in `resolveWorkspaceConfig`/`explain`/the agent's project
 * context ever reads these paths off a `WorkspaceConfig`. Without this list,
 * the root `.passthrough()` would let `oxagen config set model <x>` (etc.)
 * write a value here that prints a confident "✓" and is then never read by
 * anything — a dead-key write. `workspaceConfigSchema`'s `superRefine` rejects
 * exactly these keys at the schema layer (defense in depth alongside the
 * command-layer redirect in `commands/config.ts`'s `configSet`), while still
 * passing through genuinely-unknown future keys so forward-compat is
 * preserved.
 */
export const RUNTIME_DEAD_KEYS = [
  "model",
  "apiUrl",
  "effort",
  "token",
] as const;
export type RuntimeDeadKey = (typeof RUNTIME_DEAD_KEYS)[number];

/** The actual `oxagen config <key>` legacy-command spelling for each dead key ("api-url" is hyphenated there, unlike the `apiUrl` field name). */
export const RUNTIME_DEAD_KEY_REDIRECT: Record<RuntimeDeadKey, string> = {
  model: "model",
  apiUrl: "api-url",
  effort: "effort",
  token: "token",
};
