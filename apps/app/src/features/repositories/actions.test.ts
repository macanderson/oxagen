// The Repositories page reads and the bind, through the real viewer and
// kernel seams: the session and the kernel's invoke() are the only fakes, so
// each case shows what the page gets back and whether the capability ran.
//
// The two reads are the point of this file. They are `kernelRead` from a
// `"use server"` module — the one place in this app where a read is made on
// demand rather than by a page through a port — so what is proven here is that
// they resolve a viewer first, that neither mutates, and that every refusal
// the seam can produce arrives as something the page can print.
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
  attachGithubInstallation,
  bindWorkspaceRepository,
  connectGitLabProject,
  linkWorkspaceRepository,
  listGithubInstallations,
  closeRepositoryChange,
  listInstallationRepositories,
  mergeRepositoryChange,
  openInitPullRequest,
  readRepositoryChange,
  readRepositoryChanges,
  readRepositoryTree,
  readWorkspaceRepositories,
  readWorkspaceRepository,
  setProductionBranch,
  unlinkWorkspaceRepository,
} = await import("./actions");

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
    connectUrl:
      "https://github.com/login/oauth/authorize?client_id=Iv1.test&state=s",
    installUrl: "https://github.com/apps/oxagen/installations/new?state=s",
    manageUrl: null,
  },
};

const BOUND = {
  repository: {
    bindingId: "rpb_0a1b2c",
    provider: "github",
    owner: "acme",
    name: "platform",
    fullName: "acme/platform",
    defaultRef: "main",
    htmlUrl: "https://github.com/acme/platform",
    boundAt: "2026-09-16T10:00:00.000Z",
    connectionLive: true,
  },
  github: {
    connected: true,
    connectUrl: null,
    installUrl: null,
    manageUrl: "https://github.com/settings/installations/42",
  },
};

const CANDIDATES = {
  installations: [
    {
      installationId: "424242",
      accountLogin: "acme",
      accountType: "Organization",
      avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
      repositorySelection: "all",
    },
  ],
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

/** What `list_repositories` answers for a workspace with its main and one linked repository. */
const REPOSITORIES = {
  repositories: [
    {
      bindingId: "rpb_0a1b2c",
      provider: "github",
      role: "main",
      owner: "acme",
      name: "platform",
      fullName: "acme/platform",
      defaultRef: "main",
      htmlUrl: "https://github.com/acme/platform",
      boundAt: "2026-09-16T10:00:00.000Z",
      connectionLive: true,
      events: "installed",
    },
    {
      bindingId: "rpb_0d1e2f",
      provider: "github",
      role: "linked",
      owner: "acme",
      name: "docs-site",
      fullName: "acme/docs-site",
      defaultRef: "trunk",
      htmlUrl: "https://github.com/acme/docs-site",
      boundAt: "2026-09-17T10:00:00.000Z",
      connectionLive: false,
      events: "retired",
    },
  ],
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
      code: "repository.read",
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

  // The page failure says what is down: the installation, not a store of ours.
  it("names the installation when the read fails for a reason the seam cannot classify (negative)", async () => {
    invoke.mockRejectedValue(new Error("socket hang up"));
    expect(await readWorkspaceRepository("acme", "core-platform")).toEqual({
      ok: false,
      reason: "unavailable",
      code: "installation_unreachable",
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
      { ok: false, reason: "conflict", code: "github_not_connected" },
    );
  });
});

describe("bindWorkspaceRepository", () => {
  it("binds the picked repository and answers with what the handler wrote", async () => {
    invoke.mockResolvedValue({
      bindingId: "rpb_0a1b2c",
      provider: "github",
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
      provider: "github",
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

describe("listGithubInstallations", () => {
  it("answers the set attach_github_installation will accept", async () => {
    invoke.mockResolvedValue(CANDIDATES);
    expect(await listGithubInstallations("acme", "core-platform")).toEqual({
      ok: true,
      value: CANDIDATES,
    });
  });

  it("reads list_github_installations for the workspace the URL names, with no input", async () => {
    invoke.mockResolvedValue(CANDIDATES);
    await listGithubInstallations("acme", "core-platform");
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "list_github_installations",
      {},
      expect.objectContaining({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: "app",
      }),
    );
  });

  // The ordinary first-time state. The dialog draws it as the Connect door
  // rather than as an alarm, so the code has to arrive intact.
  it("carries the conflict an org that never authorized GitHub gets (negative)", async () => {
    invoke.mockRejectedValue({
      code: "conflict",
      reason: "github_not_authorized",
    });
    expect(await listGithubInstallations("acme", "core-platform")).toEqual({
      ok: false,
      reason: "conflict",
      code: "github_not_authorized",
    });
  });

  it("carries a denial across as denied (negative)", async () => {
    invoke.mockRejectedValue({ code: "authz_denied" });
    expect(await listGithubInstallations("acme", "core-platform")).toEqual({
      ok: false,
      reason: "denied",
      code: "repository.read",
    });
  });
});

describe("attachGithubInstallation", () => {
  it("attaches the picked installation and answers what the handler wrote", async () => {
    invoke.mockResolvedValue({
      connectionId: "con_abc123",
      accountLogin: "acme",
    });
    expect(
      await attachGithubInstallation("acme", "core-platform", "424242"),
    ).toEqual({
      ok: true,
      value: { connectionId: "con_abc123", accountLogin: "acme" },
    });
  });

  it("names only the installation id, which the handler then verifies", async () => {
    invoke.mockResolvedValue({
      connectionId: "con_abc123",
      accountLogin: null,
    });
    await attachGithubInstallation("acme", "core-platform", "424242");
    expect(invoke.mock.calls[0]?.[0]).toBe("attach_github_installation");
    expect(invoke.mock.calls[0]?.[1]).toEqual({ installationId: "424242" });
  });

  // The security property, said back at this seam: an id the connected account
  // cannot reach is a refusal the dialog prints, not a write.
  it("reads back an installation the account cannot reach (negative)", async () => {
    invoke.mockRejectedValue({
      code: "not_found",
      reason: "installation_unreachable",
    });
    expect(
      await attachGithubInstallation("acme", "core-platform", "999999"),
    ).toEqual({
      ok: false,
      reason: "not_found",
      code: "installation_unreachable",
    });
  });

  // The contract's pattern is `installationIdOf`'s: a value every reader would
  // silently skip must not reach the kernel, let alone a connection row.
  it("refuses an id that is not a plain positive integer before the kernel runs (negative)", async () => {
    const result = await attachGithubInstallation(
      "acme",
      "core-platform",
      "not-a-number",
    );
    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "installationId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("readWorkspaceRepositories", () => {
  it("answers every repository the workspace binds, with each one's role", async () => {
    invoke.mockResolvedValue(REPOSITORIES);
    expect(await readWorkspaceRepositories("acme", "core-platform")).toEqual({
      ok: true,
      value: REPOSITORIES,
    });
  });

  it("reads list_repositories for the workspace the URL names, with no input", async () => {
    invoke.mockResolvedValue({ repositories: [] });
    await readWorkspaceRepositories("acme", "core-platform");
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "list_repositories",
      {},
      expect.objectContaining({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: "app",
      }),
    );
  });

  it("carries a denial across as denied (negative)", async () => {
    invoke.mockRejectedValue({ code: "authz_denied" });
    expect(await readWorkspaceRepositories("acme", "core-platform")).toEqual({
      ok: false,
      reason: "denied",
      code: "repository.read",
    });
  });

  it("refuses a record with a role the contract does not name (negative)", async () => {
    invoke.mockResolvedValue({
      repositories: [{ ...REPOSITORIES.repositories[0], role: "fork" }],
    });
    expect(await readWorkspaceRepositories("acme", "core-platform")).toEqual({
      ok: false,
      reason: "unavailable",
      code: "contract_output_mismatch",
    });
  });
});

describe("linkWorkspaceRepository", () => {
  const LINKED = {
    bindingId: "rpb_0d1e2f",
    connectionId: "con_01hq",
    fullName: "acme/docs-site",
    defaultRef: "trunk",
    role: "linked",
    linkedAt: "2026-09-17T10:00:00.000Z",
  };

  it("links the named repository and answers what the handler wrote", async () => {
    invoke.mockResolvedValue(LINKED);
    expect(
      await linkWorkspaceRepository("acme", "core-platform", {
        owner: "acme",
        name: "docs-site",
      }),
    ).toEqual({
      ok: true,
      value: {
        bindingId: "rpb_0d1e2f",
        fullName: "acme/docs-site",
        defaultRef: "trunk",
        linkedAt: "2026-09-17T10:00:00.000Z",
      },
    });
  });

  it("names only the repository, on GitHub: the installation is the workspace's own", async () => {
    invoke.mockResolvedValue(LINKED);
    await linkWorkspaceRepository("acme", "core-platform", {
      owner: "acme",
      name: "docs-site",
    });
    expect(invoke.mock.calls[0]?.[0]).toBe("link_repository");
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      provider: "github",
      owner: "acme",
      name: "docs-site",
    });
  });

  // Every refusal the contract documents, carried with its reason intact so
  // the section prints its own sentence for each.
  it.each([
    ["conflict", "github_not_connected"],
    ["conflict", "main_repo"],
    ["conflict", "repository_already_linked"],
    ["conflict", "main_repo_claimed"],
    ["conflict", "main_repo_unbound"],
    ["not_found", "repository_not_installed"],
  ] as const)(
    "carries a %s: %s from the handler to the caller (negative)",
    async (code, reason) => {
      invoke.mockRejectedValue({ code, reason });
      expect(
        await linkWorkspaceRepository("acme", "core-platform", {
          owner: "acme",
          name: "docs-site",
        }),
      ).toEqual({ ok: false, reason: code, code: reason });
    },
  );

  it("refuses a repository name GitHub would not accept before the kernel runs (negative)", async () => {
    expect(
      await linkWorkspaceRepository("acme", "core-platform", {
        owner: "acme",
        name: "not a repo name",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "name",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("unlinkWorkspaceRepository", () => {
  it("unlinks the binding the list named and answers what left", async () => {
    invoke.mockResolvedValue({
      bindingId: "rpb_0d1e2f",
      fullName: "acme/docs-site",
      unlinkedAt: "2026-09-18T10:00:00.000Z",
    });
    expect(
      await unlinkWorkspaceRepository("acme", "core-platform", "rpb_0d1e2f"),
    ).toEqual({
      ok: true,
      value: {
        bindingId: "rpb_0d1e2f",
        fullName: "acme/docs-site",
        unlinkedAt: "2026-09-18T10:00:00.000Z",
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "unlink_repository",
      { bindingId: "rpb_0d1e2f" },
      expect.objectContaining({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
      }),
    );
  });

  // The invariant said back at this seam: the main repository never leaves,
  // and the refusal arrives as a sentence rather than a write.
  it("carries the refusal of the main repository across (negative)", async () => {
    invoke.mockRejectedValue({
      code: "conflict",
      reason: "main_repo_unlink_refused",
    });
    expect(
      await unlinkWorkspaceRepository("acme", "core-platform", "rpb_0a1b2c"),
    ).toEqual({
      ok: false,
      reason: "conflict",
      code: "main_repo_unlink_refused",
    });
  });

  it("carries a binding this workspace does not see across as not_found (negative)", async () => {
    invoke.mockRejectedValue({
      code: "not_found",
      reason: "repository_not_linked",
    });
    expect(
      await unlinkWorkspaceRepository("acme", "core-platform", "rpb_ffffff"),
    ).toEqual({
      ok: false,
      reason: "not_found",
      code: "repository_not_linked",
    });
  });

  it("refuses an id that is not a binding id before the kernel runs (negative)", async () => {
    expect(
      await unlinkWorkspaceRepository("acme", "core-platform", "docs-site"),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "bindingId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("readRepositoryTree", () => {
  const TREE = {
    bindingId: "rpb_0a1b2c",
    role: "main",
    fullName: "acme/platform",
    productionBranch: "main",
    githubDefaultBranch: "main",
    head: "0123456789abcdef",
    oxagen: { present: true, files: [".oxagen/workspace.toml"] },
    workspaceToml: "[workspace]\n",
    governanceToml: null,
    governanceMode: "absent",
    initPullRequest: null,
    readAt: "2026-09-19T10:00:00.000Z",
  };

  it("reads get_repository_tree for the binding it names", async () => {
    invoke.mockResolvedValue(TREE);
    expect(
      await readRepositoryTree("acme", "core-platform", "rpb_0a1b2c"),
    ).toEqual({ ok: true, value: TREE });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "get_repository_tree",
      { bindingId: "rpb_0a1b2c" },
      expect.objectContaining({ workspaceId: ctx.workspaceId, surface: "app" }),
    );
  });

  it("carries github_not_connected across as a conflict (negative)", async () => {
    invoke.mockRejectedValue({
      code: "conflict",
      reason: "github_not_connected",
    });
    expect(
      await readRepositoryTree("acme", "core-platform", "rpb_0a1b2c"),
    ).toEqual({ ok: false, reason: "conflict", code: "github_not_connected" });
  });

  it("names the installation when the read fails for a reason the seam cannot classify (negative)", async () => {
    invoke.mockRejectedValue(new Error("socket hang up"));
    expect(
      await readRepositoryTree("acme", "core-platform", "rpb_0a1b2c"),
    ).toEqual({
      ok: false,
      reason: "unavailable",
      code: "installation_unreachable",
    });
  });
});

describe("setProductionBranch", () => {
  it("sets the branch and answers what moved", async () => {
    invoke.mockResolvedValue({
      bindingId: "rpb_0a1b2d",
      fullName: "acme/platform",
      productionBranch: "release",
      previousBranch: "main",
      changed: true,
      setAt: "2026-09-19T10:00:00.000Z",
    });
    expect(
      await setProductionBranch(
        "acme",
        "core-platform",
        "rpb_0a1b2c",
        "release",
      ),
    ).toEqual({
      ok: true,
      value: {
        bindingId: "rpb_0a1b2d",
        fullName: "acme/platform",
        productionBranch: "release",
        previousBranch: "main",
        changed: true,
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "set_production_branch",
      { bindingId: "rpb_0a1b2c", branch: "release" },
      expect.objectContaining({ surface: "app" }),
    );
  });

  it("carries branch_not_found across (negative)", async () => {
    invoke.mockRejectedValue({ code: "not_found", reason: "branch_not_found" });
    expect(
      await setProductionBranch("acme", "core-platform", "rpb_0a1b2c", "nope"),
    ).toEqual({ ok: false, reason: "not_found", code: "branch_not_found" });
  });

  it("refuses a name git does not accept before the kernel runs (negative)", async () => {
    const result = await setProductionBranch(
      "acme",
      "core-platform",
      "rpb_0a1b2c",
      "two words",
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("openInitPullRequest", () => {
  const INPUT = {
    bindingId: "rpb_0d1e2f",
    governanceMode: "team" as const,
    workspaceToml: "[workspace]\n",
    governanceToml: 'mode = "team"\n',
  };

  it("opens the init pull request with the reviewed files", async () => {
    invoke.mockResolvedValue({
      bindingId: "rpb_0d1e2f",
      fullName: "acme/docs-site",
      branch: "oxagen/init",
      base: "trunk",
      pullRequest: {
        number: 7,
        htmlUrl: "https://github.com/acme/docs-site/pull/7",
      },
      files: [".oxagen/workspace.toml"],
      reused: false,
      openedAt: "2026-09-19T10:00:00.000Z",
    });
    expect(await openInitPullRequest("acme", "core-platform", INPUT)).toEqual({
      ok: true,
      value: {
        fullName: "acme/docs-site",
        branch: "oxagen/init",
        base: "trunk",
        pullRequest: {
          number: 7,
          htmlUrl: "https://github.com/acme/docs-site/pull/7",
        },
        files: [".oxagen/workspace.toml"],
        reused: false,
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "open_init_pr",
      INPUT,
      expect.objectContaining({ surface: "app" }),
    );
  });

  it("carries oxagen_tree_exists across (negative)", async () => {
    invoke.mockRejectedValue({
      code: "conflict",
      reason: "oxagen_tree_exists",
    });
    expect(await openInitPullRequest("acme", "core-platform", INPUT)).toEqual({
      ok: false,
      reason: "conflict",
      code: "oxagen_tree_exists",
    });
  });
});

describe("readRepositoryChanges", () => {
  const proposal = (id: string, status: string, pr: boolean) => ({
    id,
    lineageId: "lin_1",
    kind: "rule",
    force: "must",
    constraintEffect: null,
    sharingScope: "workspace",
    statement: `statement ${id}`,
    rationale: "",
    source: "the promoter",
    support: { runs: [], agents: [], recordIds: [], evidenceLinks: [] },
    status,
    pr: pr
      ? {
          number: 42,
          url: "https://github.com/acme/platform/pull/42",
          provider: "github",
          repository: "acme/platform",
          branch: `oxagen/${id}`,
        }
      : null,
    checks: pr ? { passed: 6, total: 6 } : null,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
  });

  it("keeps only proposals with a pull request and counts the open ones", async () => {
    invoke.mockResolvedValue({
      proposals: [
        proposal("prp_1", "checks_failed", true),
        proposal("prp_2", "merged", true),
        proposal("prp_3", "proposed", false),
      ],
      total: 3,
    });
    const result = await readRepositoryChanges("acme", "core-platform");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changes.map((c) => c.proposalId)).toEqual([
      "prp_1",
      "prp_2",
    ]);
    expect(result.value.open).toBe(1);
    expect(result.value.changes[0]).toMatchObject({
      kind: "context_record",
      openedBy: "the promoter",
      status: "checks_failed",
    });
    expect(invoke).toHaveBeenCalledWith(
      "list_proposals",
      { limit: 50, offset: 0 },
      expect.objectContaining({ surface: "app" }),
    );
  });

  it("carries a denial across as denied (negative)", async () => {
    invoke.mockRejectedValue({ code: "authz_denied" });
    expect(await readRepositoryChanges("acme", "core-platform")).toEqual({
      ok: false,
      reason: "denied",
      code: "repository.read",
    });
  });
});

describe("connectGitLabProject", () => {
  const TOKEN = "glpat-abcdefghijklmnopqrstuvwxyz";
  const ATTACHED = {
    connectionId: "con_gl1",
    projectId: "4242",
    fullName: "acme/platform/rules",
    defaultRef: "main",
    tokenExpiresAt: null,
    rotated: false,
    webhook: { status: "registered" as const },
  };
  const BOUND_GITLAB = {
    bindingId: "rpb_0a1b2d",
    connectionId: "con_gl1",
    provider: "gitlab",
    fullName: "acme/platform/rules",
    defaultRef: "main",
    boundAt: "2026-09-23T10:00:00.000Z",
    provisionalClosed: true,
  };

  beforeEach(() => {
    invoke.mockReset();
    requireViewer.mockResolvedValue(ctx);
  });

  it("attaches the token, then binds the project GitLab reported, and never answers the token", async () => {
    invoke.mockResolvedValueOnce(ATTACHED).mockResolvedValueOnce(BOUND_GITLAB);
    const result = await connectGitLabProject("acme", "core-platform", {
      projectPath: "acme/platform/rules",
      token: TOKEN,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        fullName: "acme/platform/rules",
        defaultRef: "main",
        boundAt: "2026-09-23T10:00:00.000Z",
        webhook: "registered",
      },
    });
    expect(invoke.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [
        "attach_gitlab_project",
        { projectPath: "acme/platform/rules", token: TOKEN },
      ],
      [
        "bind_main_repository",
        { provider: "gitlab", projectPath: "acme/platform/rules" },
      ],
    ]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("stops at a refused attach and binds nothing (negative)", async () => {
    invoke.mockRejectedValueOnce({
      code: "conflict",
      reason: "gitlab_token_not_project_scoped",
    });
    const result = await connectGitLabProject("acme", "core-platform", {
      projectPath: "acme/platform/rules",
      token: TOKEN,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "gitlab_token_not_project_scoped",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("readRepositoryChange", () => {
  const CONTEXT_PR = {
    proposalId: "prp_1",
    lineageId: "ctx.scr.001-never-push-to-main",
    status: "merged",
    governanceMode: "team",
    pr: {
      number: 42,
      url: "https://github.com/acme/platform/pull/42",
      provider: "github",
      repository: "acme/platform",
      baseRef: "main",
      branch: "oxagen/prp_1",
      headSha: "0123456789abcdef",
      path: ".oxagen/rules/ctx.scr.001-never-push-to-main.toml",
    },
    record: null,
    body: "Why this record",
    checks: [
      {
        name: "schema",
        status: "passed",
        summary: "The record parses.",
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    onMerge: {
      publishes: {
        lineageId: "ctx.scr.001-never-push-to-main",
        path: ".oxagen/rules/ctx.scr.001-never-push-to-main.toml",
      },
      bundleVersion: { current: 7, afterMerge: 8 },
      review: null,
    },
    merged: {
      commit: "fedcba9876543210",
      at: "2026-09-19T10:00:00.000Z",
      byUserId: null,
      promotionEventId: "pev_1",
      recordId: "rec_1",
    },
  };

  it("maps get_context_pr onto what the detail draws, the merge included", async () => {
    invoke.mockResolvedValue(CONTEXT_PR);
    const result = await readRepositoryChange("acme", "core-platform", "prp_1");
    expect(invoke).toHaveBeenCalledWith(
      "get_context_pr",
      { proposalId: "prp_1" },
      expect.objectContaining({ surface: "app" }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        proposalId: "prp_1",
        lineage: "ctx.scr.001-never-push-to-main",
        status: "merged",
        governanceMode: "team",
        pr: {
          number: 42,
          url: "https://github.com/acme/platform/pull/42",
          repository: "acme/platform",
          baseRef: "main",
          branch: "oxagen/prp_1",
          headSha: "0123456789abcdef",
        },
        body: "Why this record",
        checks: [
          { name: "schema", status: "passed", summary: "The record parses." },
        ],
        onMerge: {
          path: ".oxagen/rules/ctx.scr.001-never-push-to-main.toml",
          bundleVersion: { current: 7, afterMerge: 8 },
        },
        merged: {
          commit: "fedcba9876543210",
          at: "2026-09-19T10:00:00.000Z",
          promotionEventId: "pev_1",
          recordId: "rec_1",
        },
      },
    });
  });

  it("keeps a proposal with no pull request and no merge as nulls", async () => {
    invoke.mockResolvedValue({
      ...CONTEXT_PR,
      status: "proposed",
      governanceMode: null,
      pr: null,
      merged: null,
    });
    const result = await readRepositoryChange("acme", "core-platform", "prp_1");
    expect(result.ok && result.value.pr).toBeNull();
    expect(result.ok && result.value.merged).toBeNull();
  });

  it("carries a refusal to read across (negative)", async () => {
    invoke.mockRejectedValue({ code: "authz_denied" });
    const result = await readRepositoryChange("acme", "core-platform", "prp_1");
    expect(result.ok).toBe(false);
  });
});

describe("mergeRepositoryChange and closeRepositoryChange", () => {
  it("merges through merge_context_pr and answers the merged commit", async () => {
    invoke.mockResolvedValue({
      proposalId: "prp_1",
      status: "merged",
      record: {
        id: "rec_1",
        lineageId: "ctx.scr.001-never-push-to-main",
        version: 1,
        path: ".oxagen/rules/ctx.scr.001-never-push-to-main.toml",
      },
      mergedCommit: "fedcba9876543210",
      promotionEvent: { id: "pev_1", seq: 1, chainDigest: "d1" },
      bundleVersion: { before: 7, after: 8 },
    });
    expect(
      await mergeRepositoryChange("acme", "core-platform", "prp_1"),
    ).toEqual({ ok: true, value: { commit: "fedcba9876543210" } });
    expect(invoke).toHaveBeenCalledWith(
      "merge_context_pr",
      { proposalId: "prp_1" },
      expect.objectContaining({ surface: "app" }),
    );
  });

  it("carries a merge refusal across (negative)", async () => {
    invoke.mockRejectedValue({ code: "conflict", reason: "head_moved" });
    expect(
      await mergeRepositoryChange("acme", "core-platform", "prp_1"),
    ).toEqual({ ok: false, reason: "conflict", code: "head_moved" });
  });

  it("closes through dismiss_proposal with the previewed comment, trimmed, as the reason", async () => {
    invoke.mockResolvedValue({ proposalId: "prp_1", status: "rejected" });
    expect(
      await closeRepositoryChange(
        "acme",
        "core-platform",
        "prp_1",
        "  Closed by Mac Anderson  ",
      ),
    ).toEqual({ ok: true, value: { status: "rejected" } });
    expect(invoke).toHaveBeenCalledWith(
      "dismiss_proposal",
      { proposalId: "prp_1", reason: "Closed by Mac Anderson" },
      expect.objectContaining({ surface: "app" }),
    );
  });

  it("carries a close refusal across (negative)", async () => {
    invoke.mockRejectedValue({
      code: "not_found",
      reason: "proposal_not_found",
    });
    expect(
      await closeRepositoryChange("acme", "core-platform", "prp_1", "Closed"),
    ).toEqual({ ok: false, reason: "not_found", code: "proposal_not_found" });
  });
});
