// commit_agent_definition writes the files the agent's harness loads (#3501).
//
// Editing an agent must leave the harness reading the edited instructions.
// For Claude Code, Cursor and Stella that means the subagent file
// `.claude/agents/<slug>.md` is regenerated on the same branch as the
// definition, with the generator `propose_agent` uses at creation. For Codex
// and the other harnesses only the definition is written, because none of
// them reads a subagent file.
//
// The Postgres-backed flow lives in agent.definition.commit.test.ts and runs
// where DATABASE_URL is set. This file replaces the tenant transaction, the
// role gate and the agent lookup with fakes, so the harness branch of the
// handler runs on any machine and the test asserts what reached GitHub.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_DEFINITION_SCHEMA } from "@oxagen/oxagen/contracts/agent.definition.commit";
import { subagentFileFor } from "@oxagen/oxagen/contracts/agent.propose";
import { parse } from "smol-toml";

const state = vi.hoisted(() => ({
  harness: "claude-code",
  calls: [] as { op: string; args: Record<string, unknown> }[],
  commits: 0,
}));

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: vi.fn(async () => "usr_committer"),
  assertOrgRole: vi.fn(async () => undefined),
}));

vi.mock("@oxagen/agent/handlers/_agent-identity", () => ({
  resolveAgentIdentity: vi.fn(async () => ({
    id: "00000000-0000-4000-8000-000000000001",
    publicId: "agt_0123456789abcdefghjkmn",
    slug: "release-bot",
    name: "Release bot",
    description: null,
    harness: state.harness,
    status: "active",
  })),
}));

// Every select resolves by the table it reads: one main binding for the
// repository resolver, and no earlier version for the version row.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const rowsFor = (table: unknown): unknown[] => {
    if (table === real.schema.repositoryBindingHeads)
      return [{ currentBindingId: "binding-1" }];
    if (table === real.schema.repositoryBindings)
      return [
        {
          publicId: "rpb_0123456789abcdefghjkmn",
          owner: "acme",
          name: "core",
          configuredDefaultRef: "main",
        },
      ];
    return [];
  };
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        const rows = rowsFor(table);
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: async () => rows,
          // biome-ignore lint/suspicious/noThenProperty: drizzle's builder is awaited directly, so the fake is a thenable.
          then: (
            resolve: (value: unknown[]) => unknown,
            reject: (reason: unknown) => unknown,
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      },
    }),
    insert: () => ({
      values: (row: { version: number }) => ({
        returning: async () => [{ version: row.version }],
      }),
    }),
  };
  const withTenantDb = async (fn: (t: unknown) => Promise<unknown>) => fn(tx);
  return { ...real, withTenantDb, withOrgDb: withTenantDb };
});

vi.mock("@oxagen/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/github")>()),
  createGitHubClient: vi.fn(() => ({
    getRepoInfo: async () => ({ defaultBranch: "main" }),
    listBranches: async () => [{ name: "main" }],
    createBranch: async (args: Record<string, unknown>) => {
      state.calls.push({ op: "createBranch", args });
      return { ref: "refs/heads/agents/release-bot", sha: "base000" };
    },
    listPullRequests: async () => [],
    putFile: async (args: Record<string, unknown>) => {
      state.calls.push({ op: "putFile", args });
      state.commits += 1;
      return { commitSha: `commit-${state.commits}`, contentSha: "blob" };
    },
    openPullRequest: async (args: Record<string, unknown>) => {
      state.calls.push({ op: "openPullRequest", args });
      return { number: 7, htmlUrl: "https://github.com/acme/core/pull/7" };
    },
  })),
}));
vi.mock("@oxagen/github/workspace-token", () => ({
  resolveGitHubToken: vi.fn(async () => "ghs_test"),
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { agentDefinitionCommitHandler } from "./agent.definition.commit";
import { sha256Hex } from "./registry-digest";
import { makeCTX } from "./test-utils/fixtures";

const SOURCE = [
  `schema = "${AGENT_DEFINITION_SCHEMA}"`,
  'slug = "release-bot"',
  'name = "Release bot"',
  'description = "Cut the weekly release."',
  "tools = []",
  "",
  "[instructions]",
  'body = "Tag the release and write the notes."',
  "",
].join("\n");

const save = () =>
  agentDefinitionCommitHandler(
    {
      agentId: "release-bot",
      branch: "agents/release-bot",
      source: SOURCE,
    },
    makeCTX({ planTier: "free" }),
  );

const puts = () =>
  state.calls
    .filter((c) => c.op === "putFile")
    .map((c) => c.args as { path: string; content: string; branch: string });

beforeEach(() => {
  state.calls.length = 0;
  state.commits = 0;
});

describe("commit_agent_definition writes the files the agent's harness loads", () => {
  it.each(["claude-code", "cursor", "stella"])(
    "for %s: commits the definition, then the subagent file generated from it, on the same branch",
    async (harness) => {
      state.harness = harness;
      const out = await save();

      const expected = subagentFileFor({
        slug: "release-bot",
        harness,
        doc: parse(SOURCE),
        digest: `sha256:${sha256Hex(SOURCE)}`,
      });
      expect(expected).not.toBeNull();
      expect(puts()).toEqual([
        expect.objectContaining({
          path: ".oxagen/agents/release-bot.toml",
          content: SOURCE,
          branch: "agents/release-bot",
        }),
        expect.objectContaining({
          path: ".claude/agents/release-bot.md",
          // Byte for byte what propose_agent writes for the same source.
          content: expected!.content,
          branch: "agents/release-bot",
        }),
      ]);
      expect(puts()[1]!.content).toContain(
        "Tag the release and write the notes.",
      );
      expect(out.generatedPath).toBe(".claude/agents/release-bot.md");
      // The version row and the answer name the commit that carries both files.
      expect(out.commitSha).toBe("commit-2");
      const pr = state.calls.find((c) => c.op === "openPullRequest");
      expect(pr?.args.body).toContain(".claude/agents/release-bot.md");
    },
  );

  it.each(["codex", "claude-agent-sdk", "custom"])(
    "for %s: commits only the definition, because the harness reads no subagent file",
    async (harness) => {
      state.harness = harness;
      const out = await save();
      expect(puts().map((p) => p.path)).toEqual([
        ".oxagen/agents/release-bot.toml",
      ]);
      expect(out.generatedPath).toBeNull();
      expect(out.commitSha).toBe("commit-1");
      const pr = state.calls.find((c) => c.op === "openPullRequest");
      expect(pr?.args.body).not.toContain(".claude/agents");
    },
  );
});
