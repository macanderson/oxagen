// steering-repo/agent-file.ts: the agent file PR enrollment opens (#5149,
// ADR-266). These tests open it over the fixture steering repo on the fake
// host, with the opener's check stubbed, and merge it through
// merge_steering_pr as a person would.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ report: null as unknown }));

vi.mock("../context.steering.checks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context.steering.checks")>()),
  checkSteeringChange: vi.fn(async () => mocks.report),
}));

import { agentSchema } from "@oxagen/oxagen/steering-repo/agent";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { readTomlFile } from "@oxagen/oxagen/steering-repo/files";
import type { CheckReport } from "@oxagen/steering-check";
import { createMergeSteeringPrHandler } from "../steering.pr.merge";
import {
  REPO,
  REVIEWER,
  ctx,
  harness,
  type Harness,
} from "../context.steering.test-support";
import { createSteeringPullRequestOpener } from "../tools.pr.open";
import {
  AGENT_FILE_PULL_REQUEST,
  openAgentFilePr,
  openAgentFilePrQuietly,
  type AgentFileDeps,
  type EnrolledRuntime,
} from "./agent-file";

/** The member who enrolls the host, by internal and public id. */
const OPERATOR = {
  userId: "0192d4a8-7c1e-7a00-8000-0000000005e1",
  publicId: "usr_01k5qk7d0000000000000000",
};

function passed(): CheckReport {
  return {
    passed: true,
    results: (["schema", "references"] as const).map((check) => ({
      check,
      status: "passed" as const,
      summary: `${check} passed`,
      findings: [],
    })),
    findings: [],
  };
}

/** The fixture steering repo on main, in team mode. */
function steeringHarness(): Harness {
  const seed: Record<string, string> = {};
  for (const [path, text] of fixtureRepo()) seed[`main:${path}`] = text;
  const h = harness(seed);
  let t = Date.parse("2026-09-26T12:00:00.000Z");
  const clock = () => new Date((t += 1000));
  h.github.clock = clock;
  h.now = clock;
  return h;
}

function deps(h: Harness): AgentFileDeps {
  return {
    opener: createSteeringPullRequestOpener(
      {
        host: () => h.github,
        readIndex: async () => null,
        readContext: async () => ({
          runtimes: ["mcp-live-1"],
          members: [OPERATOR.publicId],
          teams: [],
          groups: [],
          credentials: [],
        }),
        proposals: h.store,
        now: h.now,
      },
      AGENT_FILE_PULL_REQUEST,
    ),
    host: () => h.github,
    proposals: h.store,
  };
}

function enrolled(over: Partial<EnrolledRuntime> = {}): EnrolledRuntime {
  return {
    scope: { orgId: ctx().orgId, workspaceId: ctx().workspaceId },
    operator: OPERATOR,
    runtime: { slug: "mcp-live-1", name: "mcp-live-1" },
    hostname: "mcp-live-1",
    harnesses: ["claude-code"],
    ...over,
  };
}

beforeEach(() => {
  mocks.report = passed();
});

describe("openAgentFilePr", () => {
  it("opens a steering PR that adds agents/<runtime>.toml naming the operator, the runtime, and the harness", async () => {
    const h = steeringHarness();

    const out = await openAgentFilePr(deps(h), enrolled());

    expect(out).toMatchObject({
      status: "opened",
      pullRequest: { branch: "agents/mcp-live-1" },
    });
    if (out.status !== "opened") throw new Error("no PR opened");
    const text = await h.github.readFile(
      REPO,
      "agents/mcp-live-1.toml",
      out.pullRequest.headSha,
    );
    expect(text).not.toBeNull();
    const read = readTomlFile(text ?? "", "agent/v1", agentSchema);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual({
      schema: "agent/v1",
      name: "mcp-live-1",
      label: "Claude Code on mcp-live-1",
      operator: OPERATOR.publicId,
      runtime: "mcp-live-1",
      harness: "claude-code",
    });
    // The file carries nothing agent/v1 refuses, and no secret.
    expect(text).not.toMatch(/toolbelt|budget|environment|key|token/i);
    // The PR changes that one file, and its row is an agent file proposal.
    expect(
      await h.github.changedFiles(REPO, "main", "agents/mcp-live-1"),
    ).toEqual([{ path: "agents/mcp-live-1.toml", status: "added" }]);
    expect(h.store.proposals).toHaveLength(1);
    expect(h.store.proposals[0]).toMatchObject({
      kind: "agent_file",
      lineageId: "agents/mcp-live-1",
      path: "agents",
      status: "checks_passed",
      createdById: OPERATOR.userId,
      source: `user:${OPERATOR.userId}`,
    });
    expect(h.github.checkRuns.at(-1)).toMatchObject({
      name: "Oxagen steering",
      headSha: out.pullRequest.headSha,
      conclusion: "success",
    });
  });

  it("opens no second PR while the first is open, or once it merged", async () => {
    const h = steeringHarness();
    const first = await openAgentFilePr(deps(h), enrolled());
    expect(first.status).toBe("opened");

    expect(await openAgentFilePr(deps(h), enrolled())).toEqual({
      status: "skipped",
      reason: "already_proposed",
    });

    const proposalId = h.store.proposals[0]?.publicId ?? "";
    await createMergeSteeringPrHandler(h, {
      readHealth: async () => "healthy",
      steeringCheck: async () => passed(),
    })({ proposalId }, ctx({ userId: REVIEWER }));
    expect(h.store.proposals[0]?.status).toBe("merged");

    expect(await openAgentFilePr(deps(h), enrolled())).toEqual({
      status: "skipped",
      reason: "already_proposed",
    });
    expect(h.github.pulls).toHaveLength(1);
  });

  it("opens a new PR once the earlier one was closed", async () => {
    const h = steeringHarness();
    const first = await openAgentFilePr(deps(h), enrolled());
    if (first.status !== "opened") throw new Error("no PR opened");
    await h.store.updateProposal(
      h.store.proposals[0]?.id ?? "",
      { status: "rejected", dismissedReason: "Closed on GitHub without merging" },
      ["checks_passed"],
    );
    h.github.closeOnHost(first.pullRequest.number);
    await h.github.deleteBranch(REPO, "agents/mcp-live-1");

    const again = await openAgentFilePr(deps(h), enrolled());
    expect(again.status).toBe("opened");
    expect(h.github.pulls).toHaveLength(2);
  });

  it("merges through merge_steering_pr, which puts the file on the production branch", async () => {
    const h = steeringHarness();
    await openAgentFilePr(deps(h), enrolled());
    const proposalId = h.store.proposals[0]?.publicId ?? "";

    const out = await createMergeSteeringPrHandler(h, {
      readHealth: async () => "healthy",
      steeringCheck: async () => passed(),
    })({ proposalId }, ctx({ userId: REVIEWER }));

    expect(out).toMatchObject({
      kind: "agent_file",
      pullRequest: { branch: "agents/mcp-live-1" },
      retired: [],
    });
    const merged = await h.github.readFile(REPO, "agents/mcp-live-1.toml", "main");
    expect(merged).toContain('operator = "usr_01k5qk7d0000000000000000"');
    expect(merged).toContain('runtime = "mcp-live-1"');
  });

  it("opens nothing when the production branch already holds the file", async () => {
    const h = steeringHarness();
    h.github.commit("main", "agents/mcp-live-1.toml", "written by hand\n");
    expect(await openAgentFilePr(deps(h), enrolled())).toEqual({
      status: "skipped",
      reason: "file_exists",
    });
    expect(h.github.pulls).toHaveLength(0);
  });

  it("opens nothing when another agent file names the runtime", async () => {
    const h = steeringHarness();
    // The fixture's release bot and CI reviewer both run on ci-linux-01.
    expect(
      await openAgentFilePr(
        deps(h),
        enrolled({ runtime: { slug: "ci-linux-01", name: "ci-linux-01" } }),
      ),
    ).toEqual({ status: "skipped", reason: "runtime_has_agent" });
    expect(h.github.pulls).toHaveLength(0);
  });

  it("names the first harness an agent file can hold, and says so in the PR body", async () => {
    const h = steeringHarness();
    const out = await openAgentFilePr(
      deps(h),
      enrolled({ harnesses: ["claude-desktop", "codex", "claude-code"] }),
    );
    if (out.status !== "opened") throw new Error("no PR opened");
    const text = await h.github.readFile(
      REPO,
      "agents/mcp-live-1.toml",
      out.pullRequest.headSha,
    );
    expect(text).toContain('harness = "codex"');
    expect(text).toContain('label = "Codex on mcp-live-1"');
    expect(h.github.pulls[0]?.body).toContain(
      "The host reports 3 harnesses (claude-desktop, codex, claude-code)",
    );
  });

  it("opens nothing for a host that reports only Claude Desktop", async () => {
    const h = steeringHarness();
    expect(
      await openAgentFilePr(deps(h), enrolled({ harnesses: ["claude-desktop"] })),
    ).toEqual({ status: "skipped", reason: "harness_unknown" });
  });

  it("opens nothing for a runtime slug that is not an agent name", async () => {
    const h = steeringHarness();
    expect(
      await openAgentFilePr(
        deps(h),
        enrolled({ runtime: { slug: "Not_A_Name", name: "Not A Name" } }),
      ),
    ).toEqual({ status: "skipped", reason: "name_invalid" });
  });

  it("opens nothing in a workspace with no steering repository", async () => {
    const h = steeringHarness();
    h.github.repository = null;
    expect(await openAgentFilePr(deps(h), enrolled())).toEqual({
      status: "skipped",
      reason: "no_steering_repo",
    });
  });

  it("cuts a long runtime name so the label fits the 80 characters agent/v1 takes", async () => {
    const h = steeringHarness();
    const name = `Build host ${"x".repeat(100)}`;
    const out = await openAgentFilePr(
      deps(h),
      enrolled({ runtime: { slug: "mcp-live-1", name } }),
    );
    if (out.status !== "opened") throw new Error("no PR opened");
    const text = await h.github.readFile(
      REPO,
      "agents/mcp-live-1.toml",
      out.pullRequest.headSha,
    );
    const read = readTomlFile(text ?? "", "agent/v1", agentSchema);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.label).toHaveLength(80);
    expect(read.value.label.startsWith("Claude Code on Build host ")).toBe(true);
  });
});

describe("openAgentFilePrQuietly", () => {
  it("answers the outcome when the PR opens", async () => {
    const h = steeringHarness();
    const out = await openAgentFilePrQuietly(deps(h), enrolled());
    expect(out).toMatchObject({ status: "opened" });
  });

  it("answers null instead of throwing when the steering host fails, so enrollment goes on", async () => {
    const h = steeringHarness();
    const failing: AgentFileDeps = {
      ...deps(h),
      host: () => {
        throw new Error("the steering host is down");
      },
    };
    await expect(openAgentFilePrQuietly(failing, enrolled())).resolves.toBeNull();
    expect(h.github.pulls).toHaveLength(0);
  });
});
