/**
 * Unit tests for the agent.repo.edit handler.
 *
 * Strategy:
 *  - Mock @oxagen/github so createGitHubClient returns spy methods and
 *    GitHubWorkspace is a controllable fake whose changedFiles() returns
 *    predetermined data.
 *  - Mock @oxagen/agent-engine so runCodingAgent returns a fixed result
 *    without touching any LLM endpoint.
 *  - Mock ../lib/platform-agent-ai to avoid selectModel/AI Gateway env deps.
 *  - Mock ../lib/github-token to inject a test token.
 *  - Assert the handler orchestrates these collaborators correctly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const createBranch = vi.fn();
  const putFile = vi.fn();
  const openPullRequest = vi.fn();

  const ghClient = {
    createBranch,
    putFile,
    openPullRequest,
    createRepoInOrg: vi.fn(),
    forkRepo: vi.fn(),
    getAuthenticatedUser: vi.fn(),
    getFileContent: vi.fn(),
    getTree: vi.fn(),
  };

  // Controllable changedFiles stub — tests override this per-case
  const changedFilesFn = vi.fn().mockReturnValue([
    { path: "src/a.ts", content: "export const a = 1;" },
  ]);

  const GitHubWorkspaceMock = vi.fn().mockImplementation(() => ({
    changedFiles: changedFilesFn,
  }));

  const runCodingAgentFn = vi.fn().mockResolvedValue({
    changedFiles: ["src/a.ts"],
    text: "Refactored src/a.ts as requested.",
    steps: 3,
    diff: "--- a/src/a.ts\n+++ b/src/a.ts",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    messages: [],
  });

  const fakeAgentAi = {
    stream: vi.fn(),
    generateObject: vi.fn(),
  };

  const createPlatformAgentAiFn = vi.fn().mockReturnValue(fakeAgentAi);

  return {
    createBranch,
    putFile,
    openPullRequest,
    ghClient,
    changedFilesFn,
    GitHubWorkspaceMock,
    runCodingAgentFn,
    fakeAgentAi,
    createPlatformAgentAiFn,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@oxagen/github", () => ({
  createGitHubClient: () => mocks.ghClient,
  GitHubWorkspace: mocks.GitHubWorkspaceMock,
}));

vi.mock("@oxagen/agent-engine", () => ({
  runCodingAgent: mocks.runCodingAgentFn,
}));

vi.mock("../lib/platform-agent-ai", () => ({
  createPlatformAgentAi: mocks.createPlatformAgentAiFn,
}));

vi.mock("../lib/github-token", () => ({
  resolveGitHubToken: vi.fn().mockResolvedValue("ghp_test_token"),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import type { CapabilityContext } from "@oxagen/oxagen";
import { agentRepoEdit } from "@oxagen/oxagen/contracts/agent.repo.edit";
import { agentRepoEditHandler } from "../agent.repo.edit";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ctx: CapabilityContext = {
  orgId: "org-abc",
  workspaceId: "ws-xyz",
  userId: "user-1",
  apiKeyId: null,
  requestId: "12345678abcdef00",
  surface: "api",
  messageId: "msg-99",
};

const BASE_INPUT = {
  owner: "myorg",
  repo: "myrepo",
  instruction: "Refactor src/a.ts to use arrow functions",
  maxSteps: 12 as const,
} as const;

// ── Contract validation ───────────────────────────────────────────────────────

describe("agent.repo.edit contract validation", () => {
  it("accepts a valid input", () => {
    expect(() =>
      agentRepoEdit.input.parse({
        owner: "myorg",
        repo: "myrepo",
        instruction: "Add unit tests to all files",
      }),
    ).not.toThrow();
  });

  it("rejects an instruction shorter than 10 characters", () => {
    expect(() =>
      agentRepoEdit.input.parse({
        owner: "myorg",
        repo: "myrepo",
        instruction: "x".repeat(9), // 9 chars — too short
      }),
    ).toThrow();
  });

  it("rejects maxSteps above 40", () => {
    expect(() =>
      agentRepoEdit.input.parse({
        owner: "myorg",
        repo: "myrepo",
        instruction: "Add unit tests to all files",
        maxSteps: 41,
      }),
    ).toThrow();
  });

  it("defaults maxSteps to 12 when omitted", () => {
    const parsed = agentRepoEdit.input.parse({
      owner: "myorg",
      repo: "myrepo",
      instruction: "Add unit tests to all files",
    });
    expect(parsed.maxSteps).toBe(12);
  });
});

// ── Handler — happy path ──────────────────────────────────────────────────────

describe("agentRepoEditHandler — happy path", () => {
  beforeEach(() => {
    mocks.createBranch.mockResolvedValue({ ref: "refs/heads/oxagen-agent-12345678", sha: "abc" });
    mocks.putFile.mockResolvedValue({ commitSha: "sha1", htmlUrl: "https://github.com/file" });
    mocks.openPullRequest.mockResolvedValue({
      number: 42,
      htmlUrl: "https://github.com/myorg/myrepo/pull/42",
    });
    mocks.changedFilesFn.mockReturnValue([
      { path: "src/a.ts", content: "export const a = 1;" },
    ]);
  });

  it("calls runCodingAgent with the workspace, ai port, instruction, and maxSteps", async () => {
    await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(mocks.runCodingAgentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: BASE_INPUT.instruction,
        maxSteps: 12,
        readOnly: false,
      }),
    );
  });

  it("creates the branch on GitHub with an auto-generated name", async () => {
    await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(mocks.createBranch).toHaveBeenCalledWith({
      owner: "myorg",
      repo: "myrepo",
      branch: "oxagen-agent-12345678",
      fromBranch: "main",
    });
  });

  it("uses a caller-supplied branchName when provided", async () => {
    await agentRepoEditHandler({ ...BASE_INPUT, branchName: "my-custom-branch" }, ctx);

    expect(mocks.createBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "my-custom-branch" }),
    );
  });

  it("calls putFile once for each changed file", async () => {
    mocks.changedFilesFn.mockReturnValue([
      { path: "src/a.ts", content: "// a" },
      { path: "src/b.ts", content: "// b" },
    ]);

    await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(mocks.putFile).toHaveBeenCalledTimes(2);
    expect(mocks.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/a.ts", content: "// a", branch: "oxagen-agent-12345678" }),
    );
    expect(mocks.putFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/b.ts", content: "// b", branch: "oxagen-agent-12345678" }),
    );
  });

  it("opens a pull request with the instruction as the title (truncated to 72 chars)", async () => {
    await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(mocks.openPullRequest).toHaveBeenCalledWith({
      owner: "myorg",
      repo: "myrepo",
      title: BASE_INPUT.instruction.slice(0, 72),
      head: "oxagen-agent-12345678",
      base: "main",
      body: expect.any(String),
    });
  });

  it("returns { prNumber, prUrl, branch, changedFiles, summary }", async () => {
    const result = await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(result).toEqual({
      prNumber: 42,
      prUrl: "https://github.com/myorg/myrepo/pull/42",
      branch: "oxagen-agent-12345678",
      changedFiles: ["src/a.ts"],
      summary: "Refactored src/a.ts as requested.",
    });
  });

  it("uses the supplied baseBranch when provided", async () => {
    await agentRepoEditHandler({ ...BASE_INPUT, baseBranch: "develop" }, ctx);

    expect(mocks.GitHubWorkspaceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ref: "develop" }),
    );
    expect(mocks.createBranch).toHaveBeenCalledWith(
      expect.objectContaining({ fromBranch: "develop" }),
    );
    expect(mocks.openPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ base: "develop" }),
    );
  });

  it("creates the AgentAi port with messageId from ctx.messageId when available", async () => {
    await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(mocks.createPlatformAgentAiFn).toHaveBeenCalledWith(ctx, ctx.messageId);
  });

  it("falls back to ctx.requestId when ctx.messageId is null", async () => {
    const ctxNoMessage: CapabilityContext = { ...ctx, messageId: null };
    await agentRepoEditHandler(BASE_INPUT, ctxNoMessage);

    expect(mocks.createPlatformAgentAiFn).toHaveBeenCalledWith(ctxNoMessage, ctx.requestId);
  });
});

// ── Handler — no changes guard ────────────────────────────────────────────────

describe("agentRepoEditHandler — no-changes guard", () => {
  it("throws 'Agent made no changes.' when changedFiles() returns an empty array", async () => {
    mocks.changedFilesFn.mockReturnValue([]);

    await expect(agentRepoEditHandler(BASE_INPUT, ctx)).rejects.toThrow(
      "Agent made no changes.",
    );
  });

  it("does not call createBranch, putFile, or openPullRequest when there are no changes", async () => {
    mocks.changedFilesFn.mockReturnValue([]);

    await agentRepoEditHandler(BASE_INPUT, ctx).catch(() => null);

    expect(mocks.createBranch).not.toHaveBeenCalled();
    expect(mocks.putFile).not.toHaveBeenCalled();
    expect(mocks.openPullRequest).not.toHaveBeenCalled();
  });
});
