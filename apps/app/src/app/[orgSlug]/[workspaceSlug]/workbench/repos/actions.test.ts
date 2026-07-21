/**
 * actions.test.ts — unit tests for the Repos server actions.
 *
 * Mocks lib/workbench/repos (the invoke() wrappers) and lib/workbench/scope
 * (resolveWorkbenchScope) so validation + IAM-gate logic runs in isolation,
 * mirroring workbench/sandboxes/actions.test.ts's conventions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  listReposWithMetrics,
  getRepoMetrics,
  syncRepo,
  pauseRepo,
  resumeRepo,
  configureRepo,
  createRepo,
  forkRepo,
  createBranch,
  openPr,
  getPr,
  getPrDiff,
  getCiStatus,
  putRepoFile,
  editRepoFile,
  listFileLocks,
  releaseFileLock,
} = vi.hoisted(() => ({
  listReposWithMetrics: vi.fn(),
  getRepoMetrics: vi.fn(),
  syncRepo: vi.fn(),
  pauseRepo: vi.fn(),
  resumeRepo: vi.fn(),
  configureRepo: vi.fn(),
  createRepo: vi.fn(),
  forkRepo: vi.fn(),
  createBranch: vi.fn(),
  openPr: vi.fn(),
  getPr: vi.fn(),
  getPrDiff: vi.fn(),
  getCiStatus: vi.fn(),
  putRepoFile: vi.fn(),
  editRepoFile: vi.fn(),
  listFileLocks: vi.fn(),
  releaseFileLock: vi.fn(),
}));

const { resolveWorkbenchScope } = vi.hoisted(() => ({
  resolveWorkbenchScope: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/workbench/scope", () => ({ resolveWorkbenchScope }));
vi.mock("@/lib/workbench/repos", () => ({
  listReposWithMetrics,
  getRepoMetrics,
  syncRepo,
  pauseRepo,
  resumeRepo,
  configureRepo,
  createRepo,
  forkRepo,
  createBranch,
  openPr,
  getPr,
  getPrDiff,
  getCiStatus,
  putRepoFile,
  editRepoFile,
  listFileLocks,
  releaseFileLock,
}));
vi.mock("@/lib/routes", () => ({
  workspace: {
    workbench: {
      repos: ({
        orgSlug,
        workspaceSlug,
      }: {
        orgSlug: string;
        workspaceSlug: string;
      }) => `/${orgSlug}/${workspaceSlug}/workbench/repos`,
    },
  },
}));

import {
  refreshReposAction,
  getRepoMetricsAction,
  syncRepoAction,
  pauseRepoAction,
  resumeRepoAction,
  configureRepoAction,
  createRepoAction,
  forkRepoAction,
  createBranchAction,
  openPrAction,
  getPrAction,
  getPrDiffAction,
  getCiStatusAction,
  putRepoFileAction,
  editRepoFileAction,
  listFileLocksAction,
  releaseFileLockAction,
} from "./actions";

const SCOPE = { orgSlug: "acme", workspaceSlug: "eng" };
const CTX = {
  orgId: "o1",
  workspaceId: "w1",
  userId: "u1",
  apiKeyId: null,
  requestId: "r1",
  surface: "app" as const,
  messageId: null,
};

function scope(canManage: boolean) {
  return { ctx: CTX, canManage, session: {}, org: {}, ws: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("refreshReposAction", () => {
  it("returns the repo list on success", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    listReposWithMetrics.mockResolvedValue([{ publicId: "con_1" }]);
    const res = await refreshReposAction(SCOPE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.repos).toEqual([{ publicId: "con_1" }]);
  });

  it("returns an error when the list fails", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    listReposWithMetrics.mockRejectedValue(new Error("boom"));
    const res = await refreshReposAction(SCOPE);
    expect(res.ok).toBe(false);
  });

  it("rejects invalid input without resolving scope", async () => {
    const res = await refreshReposAction({ orgSlug: "", workspaceSlug: "" });
    expect(res.ok).toBe(false);
    expect(resolveWorkbenchScope).not.toHaveBeenCalled();
  });
});

describe("getRepoMetricsAction", () => {
  it("is a read — no manage gate", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    getRepoMetrics.mockResolvedValue({ repoId: "con_1", entityCount: 0 });
    const res = await getRepoMetricsAction({ ...SCOPE, repoId: "con_1" });
    expect(res.ok).toBe(true);
    expect(getRepoMetrics).toHaveBeenCalledWith(CTX, "con_1");
  });
});

describe("syncRepoAction", () => {
  it("gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await syncRepoAction({ ...SCOPE, repoId: "con_1" });
    expect(res.ok).toBe(false);
    expect(syncRepo).not.toHaveBeenCalled();
  });

  it("defaults mode to incremental and calls the wrapper", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    syncRepo.mockResolvedValue({
      jobId: "job_1",
      status: "queued",
      mode: "incremental",
      estimatedRecords: 0,
    });
    const res = await syncRepoAction({ ...SCOPE, repoId: "con_1" });
    expect(res.ok).toBe(true);
    expect(syncRepo).toHaveBeenCalledWith(CTX, {
      repoId: "con_1",
      mode: "incremental",
      recordTypes: undefined,
    });
  });

  it("surfaces a handler error", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    syncRepo.mockRejectedValue(new Error("connection not found"));
    const res = await syncRepoAction({ ...SCOPE, repoId: "con_1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("connection not found");
  });
});

describe("pauseRepoAction / resumeRepoAction", () => {
  it("pause gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await pauseRepoAction({ ...SCOPE, repoId: "con_1" });
    expect(res.ok).toBe(false);
    expect(pauseRepo).not.toHaveBeenCalled();
  });

  it("pause succeeds for managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    pauseRepo.mockResolvedValue({
      repoId: "con_1",
      status: "paused",
      pausedAt: "now",
    });
    const res = await pauseRepoAction({ ...SCOPE, repoId: "con_1" });
    expect(res.ok).toBe(true);
  });

  it("resume succeeds for managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    resumeRepo.mockResolvedValue({
      repoId: "con_1",
      status: "active",
      resumedAt: "now",
      nextSyncAt: null,
    });
    const res = await resumeRepoAction({ ...SCOPE, repoId: "con_1" });
    expect(res.ok).toBe(true);
  });
});

describe("configureRepoAction", () => {
  it("gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await configureRepoAction({ ...SCOPE, repoId: "con_1" });
    expect(res.ok).toBe(false);
    expect(configureRepo).not.toHaveBeenCalled();
  });

  it("passes through configuration fields", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    configureRepo.mockResolvedValue({});
    const res = await configureRepoAction({
      ...SCOPE,
      repoId: "con_1",
      syncCadence: "manual",
    });
    expect(res.ok).toBe(true);
    expect(configureRepo).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({
        repoId: "con_1",
        syncCadence: "manual",
      }),
    );
  });
});

describe("createRepoAction / forkRepoAction", () => {
  it("create rejects a blank name", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    const res = await createRepoAction({ ...SCOPE, name: "  " });
    expect(res.ok).toBe(false);
    expect(createRepo).not.toHaveBeenCalled();
  });

  it("create gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await createRepoAction({ ...SCOPE, name: "my-repo" });
    expect(res.ok).toBe(false);
    expect(createRepo).not.toHaveBeenCalled();
  });

  it("create succeeds for managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    createRepo.mockResolvedValue({
      fullName: "acme/my-repo",
      htmlUrl: "https://github.com/acme/my-repo",
      defaultBranch: "main",
    });
    const res = await createRepoAction({ ...SCOPE, name: "my-repo" });
    expect(res.ok).toBe(true);
  });

  it("fork gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await forkRepoAction({
      ...SCOPE,
      owner: "octocat",
      repo: "hello-world",
    });
    expect(res.ok).toBe(false);
    expect(forkRepo).not.toHaveBeenCalled();
  });
});

describe("createBranchAction / openPrAction", () => {
  it("createBranch gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await createBranchAction({
      ...SCOPE,
      owner: "o",
      repo: "r",
      branch: "feat",
    });
    expect(res.ok).toBe(false);
    expect(createBranch).not.toHaveBeenCalled();
  });

  it("createBranch succeeds for managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    createBranch.mockResolvedValue({ ref: "refs/heads/feat", sha: "abc123" });
    const res = await createBranchAction({
      ...SCOPE,
      owner: "o",
      repo: "r",
      branch: "feat",
    });
    expect(res.ok).toBe(true);
  });

  it("openPr gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await openPrAction({
      ...SCOPE,
      owner: "o",
      repo: "r",
      title: "t",
      head: "feat",
      base: "main",
    });
    expect(res.ok).toBe(false);
    expect(openPr).not.toHaveBeenCalled();
  });
});

describe("read actions (no manage gate)", () => {
  it("getPrAction succeeds for a non-manager", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    getPr.mockResolvedValue({ number: 1 });
    const res = await getPrAction({
      ...SCOPE,
      owner: "o",
      repo: "r",
      number: 1,
    });
    expect(res.ok).toBe(true);
  });

  it("getPrDiffAction succeeds for a non-manager", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    getPrDiff.mockResolvedValue({ files: [] });
    const res = await getPrDiffAction({
      ...SCOPE,
      owner: "o",
      repo: "r",
      number: 1,
    });
    expect(res.ok).toBe(true);
  });

  it("getCiStatusAction succeeds for a non-manager", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    getCiStatus.mockResolvedValue({ overall: "passing" });
    const res = await getCiStatusAction({
      ...SCOPE,
      owner: "o",
      repo: "r",
      ref: "main",
    });
    expect(res.ok).toBe(true);
  });

  it("listFileLocksAction succeeds for a non-manager", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    listFileLocks.mockResolvedValue([]);
    const res = await listFileLocksAction({ ...SCOPE });
    expect(res.ok).toBe(true);
  });
});

describe("putRepoFileAction / editRepoFileAction / releaseFileLockAction", () => {
  it("putRepoFile gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await putRepoFileAction({
      ...SCOPE,
      owner: "o",
      repo: "r",
      path: "a.ts",
      content: "x",
      message: "m",
    });
    expect(res.ok).toBe(false);
    expect(putRepoFile).not.toHaveBeenCalled();
  });

  it("editRepoFile rejects a short instruction", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    const res = await editRepoFileAction({
      ...SCOPE,
      owner: "o",
      repo: "r",
      instruction: "short",
    });
    expect(res.ok).toBe(false);
    expect(editRepoFile).not.toHaveBeenCalled();
  });

  it("editRepoFile defaults maxSteps to 12 and gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await editRepoFileAction({
      ...SCOPE,
      owner: "o",
      repo: "r",
      instruction: "Fix the bug in the parser module",
    });
    expect(res.ok).toBe(false);
    expect(editRepoFile).not.toHaveBeenCalled();
  });

  it("editRepoFile succeeds for managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    editRepoFile.mockResolvedValue({
      prNumber: 1,
      prUrl: "https://github.com/o/r/pull/1",
      branch: "agent/fix",
      changedFiles: ["a.ts"],
      summary: "Fixed it",
      execBackend: "github-api",
    });
    const res = await editRepoFileAction({
      ...SCOPE,
      owner: "o",
      repo: "r",
      instruction: "Fix the bug in the parser module",
    });
    expect(res.ok).toBe(true);
    expect(editRepoFile).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({ owner: "o", repo: "r", maxSteps: 12 }),
    );
  });

  it("releaseFileLock gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await releaseFileLockAction({ ...SCOPE, lockId: "lock_1" });
    expect(res.ok).toBe(false);
    expect(releaseFileLock).not.toHaveBeenCalled();
  });

  it("releaseFileLock succeeds for managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    releaseFileLock.mockResolvedValue({ released: true });
    const res = await releaseFileLockAction({ ...SCOPE, lockId: "lock_1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.released).toBe(true);
  });
});
