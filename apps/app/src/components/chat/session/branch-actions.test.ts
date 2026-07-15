/**
 * branch-actions.test.ts — the branch-picker server action's load-bearing
 * invariants: the happy-path mapping, the GitHub-failure degradation to
 * `{ error }`, and — critically — that scope-resolution failures (no session,
 * non-member) PROPAGATE through Next's control flow instead of being
 * swallowed into a degraded response (they run outside the try/catch by
 * design; see the module doc in branch-actions.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getSessionOrRedirect: vi.fn(),
    resolveOrg: vi.fn(),
    resolveWorkspace: vi.fn(),
    assertOrgMember: vi.fn(),
    repoBranchListHandler: vi.fn(),
  },
}));

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: mocks.getSessionOrRedirect,
}));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mocks.resolveOrg,
  resolveWorkspace: mocks.resolveWorkspace,
  assertOrgMember: mocks.assertOrgMember,
}));
vi.mock("@oxagen/handlers/repo.branch.list", () => ({
  repoBranchListHandler: mocks.repoBranchListHandler,
}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn(
    async (_scope: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

import { listRepoBranchesAction } from "./branch-actions";

const CTX = { orgSlug: "acme", workspaceSlug: "default" };
const INPUT = { owner: "acme", repo: "platform" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionOrRedirect.mockResolvedValue({ user: { id: "user-1" } });
  mocks.resolveOrg.mockResolvedValue({ id: "org-1" });
  mocks.resolveWorkspace.mockResolvedValue({ id: "ws-1" });
  mocks.assertOrgMember.mockResolvedValue(undefined);
});

describe("listRepoBranchesAction", () => {
  it("maps the handler output to {branches, defaultBranch}", async () => {
    mocks.repoBranchListHandler.mockResolvedValue({
      branches: [
        { name: "main", sha: "a", isDefault: true, protected: true },
        { name: "dev", sha: "b", isDefault: false, protected: false },
      ],
      defaultBranch: "main",
    });
    const result = await listRepoBranchesAction(CTX, INPUT);
    expect(result).toEqual({
      branches: [
        { name: "main", isDefault: true },
        { name: "dev", isDefault: false },
      ],
      defaultBranch: "main",
    });
  });

  it("degrades a GitHub-backed handler failure to {error}", async () => {
    mocks.repoBranchListHandler.mockRejectedValue(new Error("token revoked"));
    const result = await listRepoBranchesAction(CTX, INPUT);
    expect(result).toEqual({
      error: "Couldn't load branches for this repository. Try again.",
    });
  });

  it("does NOT swallow an auth redirect — getSessionOrRedirect throws through", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    mocks.getSessionOrRedirect.mockRejectedValue(redirect);
    await expect(listRepoBranchesAction(CTX, INPUT)).rejects.toBe(redirect);
    expect(mocks.repoBranchListHandler).not.toHaveBeenCalled();
  });

  it("does NOT swallow a membership failure — assertOrgMember throws through", async () => {
    const denied = new Error("not a member");
    mocks.assertOrgMember.mockRejectedValue(denied);
    await expect(listRepoBranchesAction(CTX, INPUT)).rejects.toBe(denied);
    expect(mocks.repoBranchListHandler).not.toHaveBeenCalled();
  });

  it("does NOT swallow an unknown-org 404 — resolveOrg throws through", async () => {
    const notFound = new Error("NEXT_NOT_FOUND");
    mocks.resolveOrg.mockRejectedValue(notFound);
    await expect(listRepoBranchesAction(CTX, INPUT)).rejects.toBe(notFound);
    expect(mocks.repoBranchListHandler).not.toHaveBeenCalled();
  });
});
