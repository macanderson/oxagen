// The register gate's own actions through the real viewer and kernel seams:
// the kernel's invoke() is the only fake, so each case shows what the page
// gets back and which capability ran with which input.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { cancelRegistration, issueAgentCredential, readRegisterPlace } =
  await import("./register-actions");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "a-intel",
  orgName: "Anderson Intelligence Corp.",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "owner",
});

const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};

const WORKSPACES = {
  organization: {
    id: ctx.orgId,
    publicId: "org_01",
    slug: "a-intel",
    namespace: "a-intel",
    name: "Anderson Intelligence Corp.",
  },
  workspaces: [
    {
      id: "7b000000-0000-4000-8000-000000000009",
      publicId: "wrk_09",
      slug: "finance",
      namespace: "fin",
      name: "Finance",
      role: null,
      archivedAt: null,
      costCenter: null,
    },
    {
      id: ctx.workspaceId,
      publicId: "wrk_01",
      slug: "core-platform",
      namespace: "core",
      name: "Core platform",
      role: "owner",
      archivedAt: null,
      costCenter: null,
    },
  ],
};

const BOUND = {
  repository: {
    bindingId: "rpb_0a1b2c",
    provider: "github",
    owner: "a-intel",
    name: "platform",
    fullName: "a-intel/platform",
    defaultRef: "main",
    htmlUrl: "https://github.com/a-intel/platform",
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

function answer(byName: Record<string, unknown>) {
  invoke.mockImplementation((name: string) => {
    if (name in byName) return Promise.resolve(byName[name]);
    return Promise.reject(new Error(`unexpected ${name}`));
  });
}

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("readRegisterPlace", () => {
  it("builds the key prefix from the organization and workspace namespaces and names the main repository", async () => {
    answer({ list_workspaces: WORKSPACES, get_main_repository: BOUND });
    expect(await readRegisterPlace("a-intel", "core-platform")).toEqual({
      ok: true,
      value: { keyPrefix: "a-intel.core", repository: "a-intel/platform" },
    });
    expect(requireViewer).toHaveBeenCalledWith("a-intel", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "list_workspaces",
      { orgSlug: "a-intel", includeArchived: false },
      expect.objectContaining(TENANT),
    );
    expect(invoke).toHaveBeenCalledWith(
      "get_main_repository",
      {},
      expect.objectContaining(TENANT),
    );
  });

  it("answers null for a workspace that binds no main repository", async () => {
    answer({
      list_workspaces: WORKSPACES,
      get_main_repository: { ...BOUND, repository: null },
    });
    const result = await readRegisterPlace("a-intel", "core-platform");
    expect(result.ok && result.value.repository).toBeNull();
  });

  it("answers not_found when the list does not carry this workspace (negative)", async () => {
    answer({
      list_workspaces: {
        ...WORKSPACES,
        workspaces: [WORKSPACES.workspaces[0]],
      },
      get_main_repository: BOUND,
    });
    expect(await readRegisterPlace("a-intel", "core-platform")).toEqual({
      ok: false,
      reason: "not_found",
      code: "workspace_not_found",
    });
  });

  it("carries a refused read across as denied, building no key (negative)", async () => {
    invoke.mockImplementation((name: string) =>
      name === "get_main_repository"
        ? Promise.reject(
            new kernel.CapabilityError(name, "authz_denied", "denied"),
          )
        : Promise.resolve(WORKSPACES),
    );
    const result = await readRegisterPlace("a-intel", "core-platform");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("denied");
  });
});

describe("cancelRegistration", () => {
  it("retires the identity with a reason and lands on Fleet", async () => {
    invoke.mockResolvedValue({
      agentId: "agt_perfwatch",
      status: "retired",
      revokedCredentials: 1,
      revokedHosts: 0,
      revokedMandates: 0,
      retiredAt: "2026-09-23T14:05:00.000Z",
    });
    expect(
      await cancelRegistration("a-intel", "core-platform", "agt_perfwatch"),
    ).toEqual({ ok: true, value: { to: "/a-intel/core-platform" } });
    expect(invoke).toHaveBeenCalledWith(
      "retire_agent",
      {
        agentId: "agt_perfwatch",
        reason: "Registration cancelled before the first frame opened it.",
      },
      expect.objectContaining(TENANT),
    );
  });

  it("returns the handler's role refusal as denied, retiring nothing (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      }),
    );
    expect(
      await cancelRegistration("a-intel", "core-platform", "agt_perfwatch"),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });
});

describe("issueAgentCredential", () => {
  it("rotates the credential and returns the new secret once", async () => {
    invoke.mockResolvedValue({
      agentId: "agt_perfwatch",
      revokedCredentialId: "aky_1",
      credential: {
        id: "aky_2",
        secret: "oxa_live_s3cr3t",
        expiresAt: "2027-03-22T00:00:00.000Z",
      },
    });
    expect(
      await issueAgentCredential("a-intel", "core-platform", "agt_perfwatch"),
    ).toEqual({
      ok: true,
      value: {
        secret: "oxa_live_s3cr3t",
        expiresAt: "2027-03-22T00:00:00.000Z",
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "rotate_agent_credential",
      { agentId: "agt_perfwatch" },
      expect.objectContaining(TENANT),
    );
  });

  it("returns a refusal and no secret (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "not_found", reason: "agent_not_found" }),
    );
    expect(
      await issueAgentCredential("a-intel", "core-platform", "agt_gone"),
    ).toEqual({ ok: false, reason: "not_found", code: "agent_not_found" });
  });
});
