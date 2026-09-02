import { describe, it, expect } from "vitest";
import {
  workspaceConfigSchema,
  RUNTIME_DEAD_KEYS,
  RUNTIME_DEAD_KEY_REDIRECT,
} from "../schema.js";

describe("workspaceConfigSchema — minimal identity-only file", () => {
  it("accepts today's real workspace.json shape (WorkspaceLink, no config sections)", () => {
    const result = workspaceConfigSchema.safeParse({
      orgSlug: "acme",
      orgId: "org_abc123",
      orgName: "Acme Corp",
      workspaceSlug: "main",
      workspaceId: "ws_xyz789",
      workspaceName: "Main Workspace",
      linkedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts identity with repos", () => {
    const result = workspaceConfigSchema.safeParse({
      orgSlug: "acme",
      orgId: "org_abc123",
      orgName: "Acme Corp",
      workspaceSlug: "main",
      workspaceId: "ws_xyz789",
      workspaceName: "Main Workspace",
      repos: [{ provider: "github", fullName: "acme/api" }],
      linkedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a completely empty object (every section optional)", () => {
    expect(workspaceConfigSchema.safeParse({}).success).toBe(true);
  });
});

describe("workspaceConfigSchema — full example (design.md §4)", () => {
  const FULL = {
    $schema: "https://schemas.oxagen.sh/workspace.json",
    version: 1,

    orgSlug: "acme",
    orgId: "org_abc123",
    orgName: "Acme Corp",
    workspaceSlug: "main",
    workspaceId: "ws_xyz789",
    workspaceName: "Main Workspace",
    repos: [{ provider: "github", fullName: "acme/api" }],
    linkedAt: "2026-01-01T00:00:00.000Z",

    vision: {
      statement: "Ship a reliable knowledge-graph context engine.",
      goals: ["Ship v2"],
      nonGoals: ["Replace settings.json"],
      principles: ["Fix root cause"],
    },

    commands: {
      dev: [
        {
          run: "pnpm dev --filter @oxagen/app",
          description: "web app on :3000",
          background: true,
        },
      ],
      build: [{ run: "pnpm build" }],
      test: [{ run: "pnpm test:unit" }],
      lint: [{ run: "pnpm lint" }],
      typecheck: [{ run: "pnpm typecheck" }],
      migrate: [{ run: "pnpm db:migrate" }],
      release: [{ run: "pnpm release:patch" }],
      gate: [{ run: "pnpm gate" }],
      custom: { kill: [{ run: "pnpm kill" }] },
    },

    worktrees: {
      namePattern: "oxagen-{slug}",
      seed: {
        include: [".env", ".env.local", "creds.json", ".oxagen/settings.json"],
        exclude: [
          "**/node_modules/**",
          "**/dist/**",
          "**/.next/**",
          "**/.turbo/**",
        ],
      },
      link: ["node_modules", ".pnpm-store"],
      setup: [
        {
          run: "pnpm i --no-frozen-lockfile",
          description: "sync deps in the new worktree",
        },
      ],
      cleanup: "auto",
    },

    packageManagers: { primary: "pnpm", node: "pnpm@9", python: "uv" },

    languages: {
      typescript: {
        items: [
          {
            id: "no-any",
            kind: "rule",
            text: "No `any`.",
            enforced: true,
            origin: "manual",
          },
          {
            id: "ui-import",
            kind: "convention",
            doc: "docs/ui-imports.md",
            origin: "scan",
            source: "CLAUDE.md",
          },
        ],
      },
      english: {
        voice: {
          tone: "confident, concise, technical",
          audience: "senior engineers",
          readingLevel: "grade 9",
          person: "second",
          banned: ["leverage", "seamless"],
          glossary: { "knowledge graph": "two words, lowercase" },
        },
        items: [
          {
            id: "oxford",
            kind: "convention",
            text: "Oxford comma.",
            origin: "manual",
          },
          {
            id: "rust-errors",
            kind: "convention",
            text: "…",
            origin: "research",
            source: "https://rust-lang.github.io/api-guidelines/",
            confidence: 0.86,
          },
        ],
      },
      es: { voice: { tone: "…", formality: "usted" }, items: [] },
    },

    vcs: {
      commit: {
        convention: "conventional",
        attribution: {
          coAuthors: ["Claude <noreply@anthropic.com>"],
          trailers: { "Claude-Session": "{sessionUrl}" },
          signoff: false,
        },
      },
      pullRequest: {
        template: ".github/pull_request_template.md",
        base: "main",
        attribution: {
          footer: "Generated with Oxagen",
          assignees: ["mac@oxagen.ai"],
        },
      },
      branch: {
        convention: "{type}/{slug}",
        prefixes: { feature: "feat/", fix: "fix/", chore: "chore/" },
        protected: ["main"],
      },
    },

    issues: {
      provider: "linear",
      linear: { team: "oxagen-v2", project: "…", apiKeyEnv: "LINEAR_API_KEY" },
      github: { repo: "org/repo" },
      linkFormat: "https://linear.app/…/{id}",
    },

    database: {
      migrations: { dir: "packages/database/migrations", naming: "…" },
      release: { script: "pnpm release:patch" },
    },

    sources: {
      scan: ["workspace", "user"],
      workspace: {
        conventions: [
          "CLAUDE.md",
          "AGENTS.md",
          ".cursorrules",
          ".cursor/rules/**",
        ],
        skills: [".agents/skills", ".claude/skills", ".oxagen/skills"],
        agents: [".claude/agents", ".oxagen/agents", ".cursor/agents"],
        mcp: [".mcp.json", ".cursor/mcp.json", ".oxagen/settings.json"],
        commands: [".claude/commands", ".oxagen/commands"],
        tools: [".oxagen/tools"],
      },
      user: {
        conventions: ["~/.claude/CLAUDE.md"],
        skills: ["~/.claude/skills", "~/.oxagen/skills"],
        agents: ["~/.claude/agents", "~/.oxagen/agents"],
        mcp: ["~/.claude.json", "~/.cursor/mcp.json"],
        commands: ["~/.claude/commands"],
        tools: ["~/.oxagen/tools"],
      },
    },

    consolidated: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      skills: [
        {
          name: "coss-ui",
          scope: "workspace",
          path: ".agents/skills/coss-ui",
          description: "…",
        },
      ],
      agents: [
        {
          name: "break-fix",
          scope: "user",
          path: "~/.claude/agents/break-fix.md",
          tools: ["Read", "Edit", "Bash"],
        },
      ],
      mcpServers: [
        {
          name: "linear",
          scope: "workspace",
          transport: "stdio",
          tools: ["create_issue"],
        },
      ],
      commands: [
        {
          name: "ci-green",
          scope: "workspace",
          path: ".oxagen/commands/ci-green.md",
        },
      ],
      customTools: [{ name: "…", scope: "user" }],
      conventionsByLanguage: { typescript: [] },
      sourceFiles: [
        { path: "CLAUDE.md", scope: "workspace", kind: "conventions" },
      ],
    },

    locked: ["packageManagers.primary"],
  };

  it("parses the full example with no errors", () => {
    const result = workspaceConfigSchema.safeParse(FULL);
    if (!result.success) {
      throw new Error(
        result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      );
    }
    expect(result.success).toBe(true);
  });

  it("round-trips every section back out unchanged", () => {
    const parsed = workspaceConfigSchema.parse(FULL);
    expect(parsed.vision?.statement).toBe(FULL.vision.statement);
    expect(parsed.languages?.typescript?.items).toHaveLength(2);
    expect(parsed.vcs?.branch?.protected).toEqual(["main"]);
    expect(parsed.sources?.workspace?.skills).toContain(".agents/skills");
    expect(parsed.consolidated?.skills?.[0]?.name).toBe("coss-ui");
  });
});

describe("workspaceConfigSchema — validation", () => {
  it("rejects an unknown language item kind", () => {
    const result = workspaceConfigSchema.safeParse({
      languages: {
        typescript: { items: [{ id: "x", kind: "bogus", origin: "manual" }] },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown language item origin", () => {
    const result = workspaceConfigSchema.safeParse({
      languages: {
        typescript: { items: [{ id: "x", kind: "rule", origin: "bogus" }] },
      },
    });
    expect(result.success).toBe(false);
  });

  it("requires origin on a language item", () => {
    const result = workspaceConfigSchema.safeParse({
      languages: { typescript: { items: [{ id: "x", kind: "rule" }] } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range confidence", () => {
    const result = workspaceConfigSchema.safeParse({
      languages: {
        typescript: {
          items: [
            { id: "x", kind: "rule", origin: "research", confidence: 1.5 },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-github repo provider", () => {
    const result = workspaceConfigSchema.safeParse({
      repos: [{ provider: "gitlab", fullName: "acme/api" }],
    });
    expect(result.success).toBe(false);
  });

  it("passes through unknown top-level keys (forward-compat)", () => {
    const parsed = workspaceConfigSchema.parse({
      someFutureSection: { ok: true },
    });
    expect((parsed as Record<string, unknown>).someFutureSection).toEqual({
      ok: true,
    });
  });
});

describe("workspaceConfigSchema — RUNTIME_DEAD_KEYS guard (item 5, fix/cli-config-truth)", () => {
  it("rejects each dead-key top-level field with a message naming the real redirect command", () => {
    for (const key of RUNTIME_DEAD_KEYS) {
      const result = workspaceConfigSchema.safeParse({ [key]: "x" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.join(".") === key);
        expect(issue).toBeDefined();
        expect(issue?.message).toContain(
          `oxagen config ${RUNTIME_DEAD_KEY_REDIRECT[key]}`,
        );
      }
    }
  });

  it("still accepts a document with a dead key stripped out and every other section intact", () => {
    const result = workspaceConfigSchema.safeParse({
      vision: { statement: "ok" },
    });
    expect(result.success).toBe(true);
  });

  it("does not reject unrelated unknown top-level keys just because RUNTIME_DEAD_KEYS exists", () => {
    // Regression guard: the fix must deny-list exactly the 4 dead keys, not
    // flip the schema to `.strict()` (which would break forward-compat).
    const result = workspaceConfigSchema.safeParse({
      someFutureSection: { ok: true },
    });
    expect(result.success).toBe(true);
  });
});
