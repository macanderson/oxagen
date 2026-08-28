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
 *    trace/file-lock adapters.
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
  const changedFilesFn = vi
    .fn()
    .mockReturnValue([{ path: "src/a.ts", content: "export const a = 1;" }]);

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

vi.mock("@oxagen/agent-runner", () => ({
  // The handler enters the pipeline through the executePipelineTurn seam
  // (agent-engine v2 Phase 1); the double keeps runTurn's one-argument
  // contract by dropping the surface tag.
  executePipelineTurn: vi.fn((_surface: string, opts: unknown) =>
    mocks.runTurnFn(opts),
  ),
}));

// PR #637 (modal-sandbox-workspace) rerouted the handler through a durable
// ModalSandboxWorkspace whenever a sandbox driver is configured — and in the
// test/CI environment isSandboxAvailable() reports true, so the handler took the
// sandbox path and its getChangedFiles() entered a real tenant scope with the
// (non-UUID) fixture orgId, throwing TenantScopeError before any assertion ran.
// These tests exercise the GitHub-API fallback (they mock GitHubWorkspace's
// changedFiles), so pin the driver OFF to force that deterministic path. The
// sandbox path is a distinct concern with its own collaborators to mock.
vi.mock("@oxagen/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/sandbox")>();
  return { ...actual, isSandboxAvailable: vi.fn().mockReturnValue(false) };
});

// createPlatformAgentAi moved into @oxagen/agent/adapters (shared with the
// in-app chat route). Partial-mock the module so the other adapters resolve to
// their real (construction-only, no-network) implementations while the AI port
// stays a fake to avoid selectModel/AI Gateway env deps.
vi.mock("@oxagen/agent/adapters", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oxagen/agent/adapters")>();
  return { ...actual, createPlatformAgentAi: mocks.createPlatformAgentAiFn };
});

vi.mock("../lib/github-token", () => ({
  resolveGitHubToken: vi.fn().mockResolvedValue("ghp_test_token"),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import type { CapabilityContext } from "@oxagen/oxagen";
import { agentRepoEdit } from "@oxagen/oxagen/contracts/agent.repo.edit";
import { agentRepoEditHandler } from "../agent.repo.edit";
import { diffFileContents } from "../lib/unified-diff";

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

  it("output schema parses without diffs (backward compatible)", () => {
    const parsed = agentRepoEdit.output.parse({
      prNumber: 42,
      prUrl: "https://github.com/myorg/myrepo/pull/42",
      branch: "agent/fix",
      changedFiles: ["src/a.ts"],
      summary: "Fixed it.",
      execBackend: "github-api",
    });
    expect(parsed.diffs).toBeUndefined();
  });

  it("output schema parses the optional diffs field with real patch text", () => {
    const parsed = agentRepoEdit.output.parse({
      prNumber: 42,
      prUrl: "https://github.com/myorg/myrepo/pull/42",
      branch: "agent/fix",
      changedFiles: ["src/a.ts"],
      summary: "Fixed it.",
      execBackend: "sandbox",
      diffs: [
        {
          path: "src/a.ts",
          patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
          additions: 1,
          deletions: 1,
        },
      ],
    });
    expect(parsed.diffs).toHaveLength(1);
    expect(parsed.diffs?.[0]).toMatchObject({
      path: "src/a.ts",
      additions: 1,
      deletions: 1,
    });
  });

  it("output schema rejects a diffs entry missing required fields", () => {
    expect(() =>
      agentRepoEdit.output.parse({
        prNumber: 42,
        prUrl: "https://github.com/myorg/myrepo/pull/42",
        branch: "agent/fix",
        changedFiles: ["src/a.ts"],
        summary: "Fixed it.",
        execBackend: "sandbox",
        diffs: [{ path: "src/a.ts" }],
      }),
    ).toThrow();
  });
});

// ── Handler — pipeline invocation ────────────────────────────────────────────

describe("agentRepoEditHandler — pipeline (runTurn)", () => {
  beforeEach(() => {
    mocks.createBranch.mockResolvedValue({
      ref: "refs/heads/oxagen-agent-12345678",
      sha: "abc",
    });
    mocks.putFile.mockResolvedValue({
      commitSha: "sha1",
      htmlUrl: "https://github.com/file",
    });
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

  it("passes a workspace and trace without centralized code graph or memory", async () => {
    await agentRepoEditHandler(BASE_INPUT, ctx);

    expect(mocks.runTurnFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.any(Object),
        trace: expect.any(Object),
      }),
    );
    const options = mocks.runTurnFn.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty("codeGraph");
    expect(options).not.toHaveProperty("memory");
  });

  // agent.repo.edit (docs/specs/agent-file-locking/plan.md) is the
  // real fleet path (dispatched directly and as a subagent-fanout child), so
  // it must inject the lease-backed FileLockProvider — the same wiring point
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
    mocks.createBranch.mockResolvedValue({
      ref: "refs/heads/oxagen-agent-12345678",
      sha: "abc",
    });
    mocks.putFile.mockResolvedValue({
      commitSha: "sha1",
      htmlUrl: "https://github.com/file",
    });
    mocks.openPullRequest.mockResolvedValue({
      number: 42,
      htmlUrl: "https://github.com/myorg/myrepo/pull/42",
    });
    mocks.changedFilesFn.mockReturnValue([
      { path: "src/a.ts", content: "export const a = 1;" },
    ]);
    // GitHub-API-fallback diff path: no prior content on the base branch —
    // agent.repo.edit reconstructs the patch as a whole-file addition.
    mocks.ghClient.getFileContent.mockResolvedValue(null);
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
    await agentRepoEditHandler(
      { ...BASE_INPUT, branchName: "my-custom-branch" },
      ctx,
    );

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
      expect.objectContaining({
        path: "src/a.ts",
        content: "// a",
        branch: "oxagen-agent-12345678",
      }),
    );
    expect(mocks.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "src/b.ts",
        content: "// b",
        branch: "oxagen-agent-12345678",
      }),
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

  it("returns { prNumber, prUrl, branch, changedFiles, summary, execBackend, diffs, warnings }", async () => {
    const result = await agentRepoEditHandler(BASE_INPUT, ctx);

    // On the GitHub-API fallback path (no sandbox driver) PR #637 adds
    // execBackend: "github-api" plus a warning that shell execution was
    // unavailable — the sandbox path returns execBackend: "sandbox" and no warning.
    const expectedDiff = diffFileContents(
      "src/a.ts",
      "",
      "export const a = 1;",
    );
    expect(result).toEqual({
      prNumber: 42,
      prUrl: "https://github.com/myorg/myrepo/pull/42",
      branch: "oxagen-agent-12345678",
      changedFiles: ["src/a.ts"],
      summary: "Refactored src/a.ts as requested.",
      execBackend: "github-api",
      diffs: [expectedDiff],
      warnings: [expect.stringContaining("Shell execution was unavailable")],
    });
  });

  // PR feat/repo-diff-emission: agent.repo.edit now emits real unified-diff
  // patch text (not just paths) so the code-diff chat card can render full
  // hunks. On the GitHub-API-only backend this is reconstructed from the
  // file's content on the base branch (fetched via getFileContent) vs. the
  // agent's final content.
  describe("diffs output", () => {
    it("fetches prior content from the base branch and computes real patch text + counts", async () => {
      mocks.ghClient.getFileContent.mockResolvedValueOnce(
        "export const a = 0;",
      );

      const result = await agentRepoEditHandler(BASE_INPUT, ctx);

      expect(mocks.ghClient.getFileContent).toHaveBeenCalledWith({
        owner: "myorg",
        repo: "myrepo",
        path: "src/a.ts",
        ref: "main",
      });
      expect(result.diffs).toHaveLength(1);
      expect(result.diffs?.[0]).toMatchObject({
        path: "src/a.ts",
        additions: 1,
        deletions: 1,
      });
      expect(result.diffs?.[0]?.patch).toContain("-export const a = 0;");
      expect(result.diffs?.[0]?.patch).toContain("+export const a = 1;");
    });

    it("computes one diff per changed file", async () => {
      mocks.changedFilesFn.mockReturnValue([
        { path: "src/a.ts", content: "// a" },
        { path: "src/b.ts", content: "// b" },
      ]);
      mocks.ghClient.getFileContent.mockResolvedValue(null);

      const result = await agentRepoEditHandler(BASE_INPUT, ctx);

      expect(result.diffs).toHaveLength(2);
      expect(result.diffs?.map((d) => d.path).sort()).toEqual([
        "src/a.ts",
        "src/b.ts",
      ]);
    });

    it("omits diffs (falls back to path-only) when diff computation throws", async () => {
      mocks.ghClient.getFileContent.mockRejectedValueOnce(
        new Error("network blip"),
      );

      const result = await agentRepoEditHandler(BASE_INPUT, ctx);

      expect(result.changedFiles).toEqual(["src/a.ts"]);
      expect(result.diffs).toBeUndefined();
      // The run itself must still succeed — diff enrichment is non-critical.
      expect(result.prNumber).toBe(42);
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

    expect(mocks.createPlatformAgentAiFn).toHaveBeenCalledWith(
      ctx,
      ctx.messageId,
    );
  });

  it("falls back to ctx.requestId when ctx.messageId is null", async () => {
    const ctxNoMessage: CapabilityContext = { ...ctx, messageId: null };
    await agentRepoEditHandler(BASE_INPUT, ctxNoMessage);

    expect(mocks.createPlatformAgentAiFn).toHaveBeenCalledWith(
      ctxNoMessage,
      ctx.requestId,
    );
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
