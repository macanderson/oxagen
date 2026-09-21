// propose_agent against the in-memory GitHub the steering handlers use, with
// the Postgres facts faked: what reaches the repository, what the call
// refuses, and that a refusal writes nothing. The role gate is the org-role
// module, faked the way the Context PR tests fake it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { agentPropose } from "@oxagen/oxagen/contracts/agent.propose";

const gate = vi.hoisted(() => ({ refuse: false }));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (c: { userId: string | null }) => c.userId,
  assertOrgRole: async (
    actor: { userId: string | null },
    roles: { org: string[] },
  ) => {
    if (!actor.userId)
      throw new HandlerError({ code: "forbidden", reason: "no_principal" });
    if (gate.refuse || !roles.org.includes("Owner"))
      throw new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      });
    return "Owner";
  },
}));

import {
  type AgentProposalFacts,
  createProposeAgentHandler,
} from "./agent.propose";
import { ctx, FakeGitHub, REPO } from "./context.steering.test-support";

const definition = (over: Record<string, string> = {}) => {
  const f = {
    slug: '"perf-watch"',
    tools: '["github__get_file_contents@2", "search_graph"]',
    side_effects: '["read", "write"]',
    budget: "{ per_run_micros = 4000000 }",
    ...over,
  };
  return [
    'schema = "agent-definition/v0.1"',
    `slug = ${f.slug}`,
    'name = "Perf watch"',
    'description = "Watch the performance budget on every pull request."',
    'model_tier = "complex"',
    `tools = ${f.tools}`,
    'deny_tools = ["github__merge_pull_request@*"]',
    `side_effects = ${f.side_effects}`,
    `budget = ${f.budget}`,
    "",
    "[instructions]",
    'body = """',
    "Comment with the regression when a page gets slower.",
    '"""',
    "",
    "[harness.claude-code]",
    'color = "gold"',
    "",
  ].join("\n");
};

const input = (over: Record<string, unknown> = {}) =>
  agentPropose.input.parse({
    slug: "perf-watch",
    harness: "claude-code",
    source: definition(),
    rationale: "Watch the performance budget.",
    ...over,
  });

let github: FakeGitHub;
let facts: AgentProposalFacts;
const factsCalls: unknown[] = [];
const handler = () =>
  createProposeAgentHandler({
    github,
    facts: async (args) => {
      factsCalls.push(args);
      return facts;
    },
  });

beforeEach(() => {
  gate.refuse = false;
  github = new FakeGitHub();
  factsCalls.length = 0;
  facts = {
    slugTaken: false,
    agentKey: "a-intel.core.perf-watch",
    registry: {
      tools: [{ slug: "github__get_file_contents", versions: [1, 2] }],
      capabilities: ["search_graph"],
    },
    exceeded: [],
  };
});

describe("propose_agent", () => {
  it("surfaces a metadata update failure instead of reporting a refreshed proposal", async () => {
    await handler()(input(), ctx());
    vi.spyOn(github, "updatePullRequest").mockRejectedValueOnce(
      new Error("update refused"),
    );
    await expect(handler()(input(), ctx())).rejects.toThrow("update refused");
    expect(github.pulls).toHaveLength(1);
  });

  it("refuses to reset or write the production branch", async () => {
    github.repository = { ...REPO, defaultBranch: "agents/perf-watch" };
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      reason: "production_branch_is_proposal_branch",
    });
    expect(github.deletedBranches).toEqual([]);
    expect(github.commits).toEqual([]);
  });

  it("cuts agents/<slug>, commits the definition and the generated subagent file, and opens the pull request", async () => {
    const out = await handler()(input(), ctx());

    expect(github.branches).toEqual([
      { branch: "agents/perf-watch", from: "main" },
    ]);
    expect(github.commits.map((c) => c.path)).toEqual([
      ".oxagen/agents/perf-watch.toml",
      ".claude/agents/perf-watch.md",
    ]);
    expect(
      await github.readFile(
        REPO,
        ".oxagen/agents/perf-watch.toml",
        "agents/perf-watch",
      ),
    ).toBe(definition());
    const generated = await github.readFile(
      REPO,
      ".claude/agents/perf-watch.md",
      "agents/perf-watch",
    );
    expect(generated).toContain("name: perf-watch");
    expect(generated).toContain(out.digest);
    expect(generated).toContain("Comment with the regression");

    expect(github.pulls).toHaveLength(1);
    expect(github.pulls[0]).toMatchObject({
      title: "Agent: perf-watch",
      head: "agents/perf-watch",
      base: "main",
    });
    expect(github.pulls[0]!.body).toContain("a-intel.core.perf-watch");
    expect(github.pulls[0]!.body).toContain("Watch the performance budget.");
    expect(github.pulls[0]!.body).toContain("is a request, not a grant");

    expect(out).toMatchObject({
      slug: "perf-watch",
      agentKey: "a-intel.core.perf-watch",
      path: ".oxagen/agents/perf-watch.toml",
      generatedPath: ".claude/agents/perf-watch.md",
      branch: "agents/perf-watch",
      repository: "a-intel/platform",
      baseRef: "main",
      pullRequest: { number: github.pulls[0]!.number },
    });
    expect(out.checks.every((c) => c.passed)).toBe(true);
    expect(agentPropose.output.parse(out)).toEqual(out);
    expect(factsCalls[0]).toMatchObject({
      slug: "perf-watch",
      belt: ["github__get_file_contents@2", "search_graph"],
    });
  });

  it.each(["codex", "claude-agent-sdk", "custom"])(
    "writes no Claude subagent file for %s",
    async (harness) => {
      const first = await handler()(input(), ctx());
      const next = await handler()(input({ harness }), ctx());
      expect(github.pulls).toHaveLength(1);
      expect(github.pulls[0]?.body).toContain(harness);
      expect(github.pulls[0]?.body).toContain(next.digest);
      expect(github.pulls[0]?.body).not.toContain(
        ".claude/agents/perf-watch.md",
      );
      expect(next.generatedPath).toBeNull();
      expect(next.pullRequest.number).toBe(first.pullRequest.number);
      expect(
        await github.readFile(
          REPO,
          ".claude/agents/perf-watch.md",
          next.branch,
        ),
      ).toBeNull();
      expect(await github.readFile(REPO, next.path, next.branch)).toBe(
        definition(),
      );
    },
  );

  it("preserves a rejected branch until its owner explicitly removes it", async () => {
    const first = await handler()(input(), ctx());
    github.commit(first.branch, "rejected.md", "rejected content");
    await github.closePullRequest(REPO, first.pullRequest.number);
    await expect(
      handler()(input({ harness: "codex" }), ctx()),
    ).rejects.toMatchObject({ reason: "proposal_branch_exists" });
    expect(await github.readFile(REPO, "rejected.md", first.branch)).toBe(
      "rejected content",
    );
    expect(github.deletedBranches).toEqual([]);
  });

  it("does not claim a generated file for Codex", async () => {
    await handler()(input({ harness: "codex" }), ctx());
    expect(github.pulls.at(-1)?.body).not.toContain(
      "The subagent file is generated",
    );
  });

  it("digests the LF bytes a Windows editor sent as CRLF", async () => {
    const crlf = await handler()(
      input({ source: definition().replace(/\n/g, "\r\n") }),
      ctx(),
    );
    github = new FakeGitHub();
    const lf = await handler()(input(), ctx());
    expect(crlf.digest).toBe(lf.digest);
  });

  it("refuses a slug another agent holds, live or retired, and writes nothing (negative)", async () => {
    facts.slugTaken = true;
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      code: "conflict",
      reason: "agent_check_key",
    });
    expect(github.branches).toEqual([]);
    expect(github.commits).toEqual([]);
  });

  it("refuses a slug whose definition is already merged (negative)", async () => {
    github = new FakeGitHub({
      "main:.oxagen/agents/perf-watch.toml": definition(),
    });
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      reason: "agent_check_key",
    });
    expect(github.pulls).toEqual([]);
  });

  it("refuses a file that does not parse, and one whose slug is another (negative)", async () => {
    await expect(
      handler()(input({ source: "schema = " }), ctx()),
    ).rejects.toMatchObject({ reason: "agent_check_schema" });
    await expect(
      handler()(input({ source: definition({ slug: '"other"' }) }), ctx()),
    ).rejects.toMatchObject({ reason: "agent_check_schema" });
    expect(github.commits).toEqual([]);
  });

  it("refuses a belt pattern nothing in the registry answers to (negative)", async () => {
    await expect(
      handler()(
        input({ source: definition({ tools: '["slack__post_message@2"]' }) }),
        ctx(),
      ),
    ).rejects.toMatchObject({ reason: "agent_check_belt" });
  });

  it("refuses irreversible side effects and a belt past the author's ceiling (negative)", async () => {
    await expect(
      handler()(
        input({
          source: definition({ side_effects: '["read", "irreversible"]' }),
        }),
        ctx(),
      ),
    ).rejects.toMatchObject({ reason: "agent_check_authority" });
    facts.exceeded = ["search_graph"];
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      reason: "agent_check_authority",
    });
  });

  it("refuses a definition with no per-run budget (negative)", async () => {
    await expect(
      handler()(input({ source: definition({ budget: "{}" }) }), ctx()),
    ).rejects.toMatchObject({ reason: "agent_check_budget" });
  });

  it("refuses a credential in the instructions (negative)", async () => {
    const leaked = definition().replace(
      "Comment with",
      "Use AKIAABCDEFGHIJKLMNOP. Comment with",
    );
    await expect(
      handler()(input({ source: leaked }), ctx()),
    ).rejects.toMatchObject({ reason: "agent_check_secrets" });
    expect(github.commits).toEqual([]);
  });

  it("lands a second proposal on the pull request already open", async () => {
    await handler()(input(), ctx());
    const again = await handler()(input(), ctx());
    expect(github.pulls).toHaveLength(1);
    expect(again.pullRequest.number).toBe(github.pulls[0]!.number);
    expect(github.commits).toHaveLength(4);
  });

  it("names no key in the body while a namespace is unset", async () => {
    facts.agentKey = null;
    const out = await handler()(input(), ctx());
    expect(out.agentKey).toBeNull();
    expect(github.pulls[0]!.body).toContain(
      "After merge, register this agent under the same slug to create its identity and credential.",
    );
  });

  it("refuses a caller who is not an org Owner or Admin before reading anything (negative)", async () => {
    gate.refuse = true;
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(factsCalls).toEqual([]);
    expect(github.branches).toEqual([]);
  });

  it("says so when the workspace binds no main repository (negative)", async () => {
    github.repository = null;
    await expect(handler()(input(), ctx())).rejects.toMatchObject({
      reason: "workspace_repository_missing",
    });
  });
});
