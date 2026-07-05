/**
 * Unit tests for the agent.repo.edit handler.
 *
 * Strategy:
 *  - Mock @oxagen/github so createGitHubClient returns spy methods and
 *    GitHubWorkspace is a controllable fake whose changedFiles() returns
 *    predetermined data.
 *  - Mock @oxagen/agent-engine so runTurn (the full 6-stage pipeline) returns
 *    a fixed RunTurnResult without touching any LLM endpoint.
 *  - Partial-mock @oxagen/agent/adapters to override createPlatformAgentAi
 *    (avoids selectModel/AI Gateway env deps) while keeping the real
 *    code-graph/memory/trace/graph-sync adapters.
 *  - Mock ../lib/github-token to inject a test token.
 *  - Assert the handler orchestrates these collaborators correctly and that it
 *    invokes the full pipeline (runTurn) rather than the bare loop
 *    (runCodingAgent).
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

  // Minimal RunTurnResult-shaped mock — matches the RunTurnResult interface
  // from @oxagen/agent-engine including the `trace` field.
  const fakeTrace = {
    id: "turn_fake",
    createdAt: 0,
    cwd: "/repo",
    originalPrompt: "",
    evaluation: {
      completeness: 80,
      complexity: 50,
      recommendedTier: "balanced" as const,
      missing: [],
      contextQueries: [],
      refinedPrompt: "",
      removed: [],
      reasoning: "",
      fallback: false,
      model: "test-model",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    },
    enhancement: {
      prompt: "",
      context: "",
      resolved: [],
      lessonCount: 0,
      source: "none" as const,
    },
    selectedModel: "test-model",
    selectedTier: "balanced" as const,
    selectionRationale: "test",
    response: "",
    filesTouched: ["src/a.ts"],
    commandsRun: [],
    judgeRounds: [],
    finalComplete: true,
    steps: 3,
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 },
    durationMs: 100,
  };

  const runTurnFn = vi.fn().mockResolvedValue({
    text: "Refactored src/a.ts as requested.",
    steps: 3,
    messages: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    trace: fakeTrace,
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
    runTurnFn,
    fakeAgentAi,
    createPlatformAgentAiFn,
    fakeTrace,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@oxagen/github", () => ({
  createGitHubClient: () => mocks.ghClient,
  GitHubWorkspace: mocks.GitHubWorkspaceMock,
}));

vi.mock("@oxagen/agent-engine", () => ({
  runTurn: mocks.runTurnFn,
}));

// createPlatformAgentAi moved into @oxagen/agent/adapters (shared with the
// in-app chat route). Partial-mock the module so the other adapters resolve to
// their real (construction-only, no-network) implementations while the AI port
// stays a fake to avoid selectModel/AI Gateway env deps.
vi.mock("@oxagen/agent/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/agent/adapters")>();
  return { ...actual, createPlatformAgentAi: mocks.createPlatformAgentAiFn };
});

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

// ── Handler — pipeline invocation ────────────────────────────────────────────

describe("agentRepoEditHandler — pipeline (runTurn)", () => {
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

  it("calls the full pipeline (runTurn) — not the bare loop (runCodingAgent)", async () => {
    await agentRepoEditHandler(BASE_INPUT, ctx);

    // runTurn must be called; runCodingAgent must NOT appear in the mock set.
    expect(mocks.runTurnFn).toHaveBeenCalledOnce();
  });

  it("passes the instruction as `prompt` to runTurn", async () => {
    await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(mocks.runTurnFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: BASE_INPUT.instruction,
      }),
    );
  });

  it("passes maxSteps and readOnly:false to runTurn", async () => {
    await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(mocks.runTurnFn).toHaveBeenCalledWith(
      expect.objectContaining({
        maxSteps: 12,
        readOnly: false,
      }),
    );
  });

  it("passes the platform AgentAi port to runTurn", async () => {
    await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(mocks.runTurnFn).toHaveBeenCalledWith(
      expect.objectContaining({
        ai: mocks.fakeAgentAi,
      }),
    );
  });

  it("passes a workspace, codeGraph, memory, and trace to runTurn", async () => {
    await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(mocks.runTurnFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.any(Object),
        codeGraph: expect.any(Object),
        memory: expect.any(Object),
        trace: expect.any(Object),
      }),
    );
  });

  // OXA-2070 (docs/specs/agent-file-locking/plan.md): agent.repo.edit is the
  // real fleet path (dispatched directly and as a subagent-fanout child), so
  // it must inject the graph-backed FileLockProvider — the same wiring point
  // write_file/edit_file in tools.ts acquire/release through.
  it("passes a fileLock adapter (FileLockProvider) to runTurn", async () => {
    await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(mocks.runTurnFn).toHaveBeenCalledWith(
      expect.objectContaining({
        fileLock: expect.objectContaining({
          acquire: expect.any(Function),
          release: expect.any(Function),
          releaseAll: expect.any(Function),
        }),
      }),
    );
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
