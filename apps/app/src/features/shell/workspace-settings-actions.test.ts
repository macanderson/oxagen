// The Workspace settings reads and the bind, through the real viewer and
// kernel seams: the session and the kernel's invoke() are the only fakes, so
// each case shows what the dialog gets back and whether the capability ran.
//
// The two reads are the point of this file. They are `kernelRead` from a
// `"use server"` module — the one place in this app where a read is made on
// demand rather than by a page through a port — so what is proven here is that
// they resolve a viewer first, that neither mutates, and that every refusal
// the seam can produce arrives as something the dialog can print.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, getSession, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  getSession: vi.fn(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const {
  bindWorkspaceRepository,
  listInstallationRepositories,
  readWorkspaceRepository,
} = await import("./workspace-settings-actions");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const UNBOUND = {
  repository: null,
  github: {
    connected: false,
    installUrl: "https://github.com/apps/oxagen/installations/new?state=s",
    manageUrl: null,
  },
};

const BOUND = {
  repository: {
    bindingId: "rpb_0a1b2c",
    owner: "acme",
    name: "platform",
    fullName: "acme/platform",
    defaultRef: "main",
    htmlUrl: "https://github.com/acme/platform",
    boundAt: "2026-09-16T10:00:00.000Z",
  },
  github: {
    connected: true,
    installUrl: null,
    manageUrl: "https://github.com/settings/installations/42",
  },
};

const LISTING = {
  repositories: [
    {
      id: "8812",
      owner: "acme",
      name: "platform",
      fullName: "acme/platform",
      defaultBranch: "main",
      private: true,
      htmlUrl: "https://github.com/acme/platform",
    },
  ],
  truncated: false,
};

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
  getSession.mockResolvedValue({
    user: { id: ctx.userId, email: "marcus.bell@acme.example" },
  });
});

describe("readWorkspaceRepository", () => {
  it("answers the bound repository and the doors to GitHub in one record", async () => {
    invoke.mockResolvedValue(BOUND);
    expect(await readWorkspaceRepository("acme", "core-platform")).toEqual({
      ok: true,
      value: BOUND,
    });
  });

  it("reads get_main_repository for the workspace the URL names, with no input", async () => {
    invoke.mockResolvedValue(UNBOUND);
    await readWorkspaceRepository("acme", "core-platform");
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "get_main_repository",
      {},
      expect.objectContaining({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: "app",
      }),
    );
  });

  it("carries a denial across as denied, naming the permission the page failure names (negative)", async () => {
    invoke.mockRejectedValue({ code: "authz_denied" });
    expect(await readWorkspaceRepository("acme", "core-platform")).toEqual({
      ok: false,
      reason: "denied",
      code: "org.admin",
    });
  });

  it("carries a pending approval across with the request to wait on (negative)", async () => {
    invoke.mockRejectedValue({
      code: "pending_approval",
      accessRequestId: "acr_0101",
    });
    expect(await readWorkspaceRepository("acme", "core-platform")).toEqual({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "acr_0101",
    });
  });

  // The page failure says what is down: GitHub, not a store of ours.
  it("names GitHub when the read fails for a reason the seam cannot classify (negative)", async () => {
    invoke.mockRejectedValue(new Error("socket hang up"));
    expect(await readWorkspaceRepository("acme", "core-platform")).toEqual({
      ok: false,
      reason: "unavailable",
      code: "github_unreachable",
    });
  });

  it("refuses a record the contract's own output schema does not accept (negative)", async () => {
    invoke.mockResolvedValue({
      repository: null,
      github: { connected: "yes" },
    });
    expect(await readWorkspaceRepository("acme", "core-platform")).toEqual({
      ok: false,
      reason: "unavailable",
      code: "contract_output_mismatch",
    });
  });
});

describe("listInstallationRepositories", () => {
  it("answers the set bind_main_repository will accept", async () => {
    invoke.mockResolvedValue(LISTING);
    expect(await listInstallationRepositories("acme", "core-platform")).toEqual(
      { ok: true, value: LISTING },
    );
  });

  it("reads list_installation_repositories with no input: the installation is never named by a caller", async () => {
    invoke.mockResolvedValue(LISTING);
    await listInstallationRepositories("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "list_installation_repositories",
      {},
      expect.anything(),
    );
  });

  it("carries the conflict a workspace with no installation gets (negative)", async () => {
    invoke.mockRejectedValue({
      code: "conflict",
      reason: "github_not_connected",
    });
    expect(await listInstallationRepositories("acme", "core-platform")).toEqual(
      { ok: false, reason: "unavailable", code: "conflict" },
    );
  });
});

describe("bindWorkspaceRepository", () => {
  it("binds the picked repository and answers with what the handler wrote", async () => {
    invoke.mockResolvedValue({
      bindingId: "rpb_0a1b2c",
      connectionId: "con_01hq",
      fullName: "acme/platform",
      defaultRef: "main",
      boundAt: "2026-09-17T09:00:00.000Z",
      provisionalClosed: true,
    });
    expect(
      await bindWorkspaceRepository("acme", "core-platform", {
        owner: "acme",
        name: "platform",
      }),
    ).toEqual({
      ok: true,
      value: {
        fullName: "acme/platform",
        defaultRef: "main",
        boundAt: "2026-09-17T09:00:00.000Z",
      },
    });
  });

  it("names only the repository: the installation comes from the workspace's connection", async () => {
    invoke.mockResolvedValue({
      bindingId: "rpb_0a1b2c",
      connectionId: "con_01hq",
      fullName: "acme/platform",
      defaultRef: "main",
      boundAt: "2026-09-17T09:00:00.000Z",
      provisionalClosed: false,
    });
    await bindWorkspaceRepository("acme", "core-platform", {
      owner: "acme",
      name: "platform",
    });
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      owner: "acme",
      name: "platform",
    });
  });

  it("reads back a workspace that already binds another repository (negative)", async () => {
    invoke.mockRejectedValue({ code: "conflict", reason: "main_repo_bound" });
    expect(
      await bindWorkspaceRepository("acme", "core-platform", {
        owner: "acme",
        name: "other",
      }),
    ).toEqual({ ok: false, reason: "conflict", code: "main_repo_bound" });
  });

  it("reads back a repository the installation cannot see (negative)", async () => {
    invoke.mockRejectedValue({
      code: "not_found",
      reason: "repository_not_installed",
    });
    expect(
      await bindWorkspaceRepository("acme", "core-platform", {
        owner: "acme",
        name: "unreachable",
      }),
    ).toEqual({
      ok: false,
      reason: "not_found",
      code: "repository_not_installed",
    });
  });

  it("refuses a repository name GitHub would not accept before the kernel runs (negative)", async () => {
    const result = await bindWorkspaceRepository("acme", "core-platform", {
      owner: "acme",
      name: "not a repo name",
    });
    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "name",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
