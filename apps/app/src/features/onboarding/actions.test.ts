// The organization action through the real viewer and kernel seams: the session
// and the kernel's invoke() are the only fakes, so each case shows what the
// person gets back and whether create_org ran.
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, getSession, redirect, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  getSession: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
// requireUser stays real: the organization action runs before any tenant, and
// its signed-out redirect is one of the cases below.
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const {
  advanceOnboarding,
  bindMainRepository,
  createOrganizationAction,
  issueEnrollmentToken,
  registerAgent,
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

/** The CapabilityContext every workspace write reaches the kernel with. */
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};

const agentForm = {
  slug: "release-bot",
  name: "Release bot",
  description: "",
  harness: "claude-code",
};

const form = {
  name: "  Acme Robotics ",
  slug: "acme",
  namespace: "acme",
  workspaceName: "Core platform",
  workspaceSlug: "core-platform",
};
const created = {
  publicId: "org_01",
  name: "Acme Robotics",
  slug: "acme",
  type: "business",
  createdAt: "2026-09-15T00:00:00.000Z",
  workspace: { publicId: "wrk_01", slug: "core-platform" },
};

beforeEach(() => {
  invoke.mockReset();
  redirect.mockClear();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
  getSession.mockResolvedValue({
    user: { id: "u-owner", email: "priya@acme.example" },
  });
});

describe("createOrganizationAction", () => {
  it("sends a signed-out visitor to log in and back, creating nothing (negative)", async () => {
    getSession.mockResolvedValue(null);
    await expect(createOrganizationAction(form)).rejects.toThrow(
      "NEXT_REDIRECT /login?next=%2Fnew-organization",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an invalid field with its catalog key, creating nothing (negative)", async () => {
    expect(
      await createOrganizationAction({ ...form, workspaceSlug: "billing" }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "workspaceSlugReserved",
      field: "workspaceSlug",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a kernel denial as denied (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError(
        organizationCreate.name,
        "authz_denied",
        "denied",
      ),
    );
    expect(await createOrganizationAction(form)).toEqual({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
  });

  it("returns a taken address as the handler's conflict (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "conflict", reason: "slug_taken" }),
    );
    expect(await createOrganizationAction(form)).toEqual({
      ok: false,
      reason: "conflict",
      code: "slug_taken",
    });
  });

  it("returns a taken namespace as the handler's conflict (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "conflict", reason: "namespace_taken" }),
    );
    expect(await createOrganizationAction(form)).toEqual({
      ok: false,
      reason: "conflict",
      code: "namespace_taken",
    });
  });

  it("refuses a namespace outside 2-6 letters or digits, creating nothing (negative)", async () => {
    expect(
      await createOrganizationAction({ ...form, namespace: "a-intel" }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "namespaceInvalid",
      field: "namespace",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("creates the organization with its chosen namespace as the signed-in person and continues to Wrap an agent", async () => {
    invoke.mockResolvedValue(created);
    expect(await createOrganizationAction(form)).toEqual({
      ok: true,
      value: { to: "/welcome/acme/core-platform/wrap" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "create_org",
      {
        name: "Acme Robotics",
        slug: "acme",
        namespace: "acme",
        workspace: { name: "Core platform", slug: "core-platform" },
      },
      expect.objectContaining({
        userId: "u-owner",
        orgId: "",
        workspaceId: "",
      }),
    );
  });
});

describe("registerAgent", () => {
  const registered = {
    agentId: "agt_releasebot",
    slug: "release-bot",
    agentKey: "acme.core.release-bot",
    principalId: "prn_91",
    credential: {
      id: "aky_1",
      secret: "oxa_ag_s3cr3t",
      expiresAt: "2027-03-14T00:00:00.000Z",
    },
  };

  it("mints the identity for the workspace viewer, keeps the secret on the server and names the wrap step", async () => {
    invoke.mockResolvedValue(registered);
    const result = await registerAgent("acme", "core-platform", agentForm);
    expect(JSON.stringify(result)).not.toContain("oxa_ag_s3cr3t");
    expect(result).toEqual({
      ok: true,
      value: {
        agentId: "agt_releasebot",
        agentKey: "acme.core.release-bot",
        to: "/acme/core-platform/register/wrap?agent=agt_releasebot",
      },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "register_agent",
      { slug: "release-bot", name: "Release bot", harness: "claude-code" },
      expect.objectContaining(TENANT),
    );
  });

  it.each(["claude-agent-sdk", "custom"])(
    "registers %s, which the wrap step's SDK tab takes",
    async (harness) => {
      invoke.mockResolvedValue(registered);
      const result = await registerAgent("acme", "core-platform", {
        ...agentForm,
        harness,
      });
      expect(result.ok).toBe(true);
      expect(invoke).toHaveBeenCalledWith(
        "register_agent",
        expect.objectContaining({ harness }),
        expect.objectContaining(TENANT),
      );
    },
  );

  it("refuses a harness the contract does not know, before minting an identity (negative)", async () => {
    expect(
      await registerAgent("acme", "core-platform", {
        ...agentForm,
        harness: "codex-cli",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "agentHarnessInvalid",
      field: "harness",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends a description only when one was written", async () => {
    invoke.mockResolvedValue(registered);
    await registerAgent("acme", "core-platform", {
      ...agentForm,
      description: " Cuts releases. ",
    });
    expect(invoke).toHaveBeenCalledWith(
      "register_agent",
      expect.objectContaining({ description: "Cuts releases." }),
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a slug the contract would refuse, before the kernel runs (negative)", async () => {
    expect(
      await registerAgent("acme", "core-platform", {
        ...agentForm,
        slug: "Release Bot",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "agentSlugInvalid",
      field: "slug",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's role refusal as denied (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      }),
    );
    expect(await registerAgent("acme", "core-platform", agentForm)).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
  });
});

describe("issueEnrollmentToken", () => {
  it("mints the single-use token and its enroll command for the named agent", async () => {
    invoke.mockResolvedValue({
      tokenId: "tet_1",
      token: "oxe_1time_7qk4m2nv9xr3t8zpabcdefghjk",
      expiresAt: "2026-09-15T14:30:00.000Z",
      agentId: "agt_releasebot",
      agentKey: "acme.core.release-bot",
      enrollCommand:
        "oxagen agent enroll --token oxe_1time_7qk4m2nv9xr3t8zpabcdefghjk",
    });
    expect(
      await issueEnrollmentToken("acme", "core-platform", "agt_releasebot"),
    ).toEqual({
      ok: true,
      value: {
        token: "oxe_1time_7qk4m2nv9xr3t8zpabcdefghjk",
        expiresAt: "2026-09-15T14:30:00.000Z",
        agentKey: "acme.core.release-bot",
        enrollCommand:
          "oxagen agent enroll --token oxe_1time_7qk4m2nv9xr3t8zpabcdefghjk",
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "create_enrollment_token",
      { agentId: "agt_releasebot" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an empty agent before the kernel runs (negative)", async () => {
    expect(await issueEnrollmentToken("acme", "core-platform", "")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "agentId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns an agent outside this workspace as not_found (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "not_found", reason: "agent_not_found" }),
    );
    expect(
      await issueEnrollmentToken("acme", "core-platform", "agt_elsewhere"),
    ).toEqual({ ok: false, reason: "not_found", code: "agent_not_found" });
  });
});

describe("advanceOnboarding", () => {
  it("moves the gate to the run step for the workspace viewer", async () => {
    invoke.mockResolvedValue({
      step: "run",
      changedAt: "2026-09-15T14:00:00.000Z",
    });
    expect(await advanceOnboarding("acme", "core-platform", "run")).toEqual({
      ok: true,
      value: { step: "run", changedAt: "2026-09-15T14:00:00.000Z" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "advance_onboarding",
      { to: "run" },
      expect.objectContaining(TENANT),
    );
  });

  it("returns the handler's refusal to skip the run step as a conflict (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "first_frame_required",
      }),
    );
    expect(await advanceOnboarding("acme", "core-platform", "run")).toEqual({
      ok: false,
      reason: "conflict",
      code: "first_frame_required",
    });
  });

  it("returns a workspace that carries no gate as not_found (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "not_found", reason: "gate_not_found" }),
    );
    expect(await advanceOnboarding("acme", "core-platform", "wrap")).toEqual({
      ok: false,
      reason: "not_found",
      code: "gate_not_found",
    });
  });
});

describe("bindMainRepository", () => {
  const repository = { owner: "acme", name: "platform" };

  it("binds the repository and reports whether it closed the provisional window", async () => {
    invoke.mockResolvedValue({
      bindingId: "rpb_1",
      connectionId: "con_1",
      fullName: "acme/platform",
      defaultRef: "main",
      boundAt: "2026-09-15T14:10:00.000Z",
      provisionalClosed: true,
    });
    expect(
      await bindMainRepository("acme", "core-platform", repository),
    ).toEqual({
      ok: true,
      value: {
        fullName: "acme/platform",
        defaultRef: "main",
        boundAt: "2026-09-15T14:10:00.000Z",
        provisionalClosed: true,
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "bind_main_repository",
      { owner: "acme", name: "platform" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a repository name the contract would refuse, before the kernel runs (negative)", async () => {
    expect(
      await bindMainRepository("acme", "core-platform", {
        owner: "acme",
        name: "not a repo",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "name",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a workspace with no installation as a conflict (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "github_not_connected",
      }),
    );
    expect(
      await bindMainRepository("acme", "core-platform", repository),
    ).toEqual({
      ok: false,
      reason: "conflict",
      code: "github_not_connected",
    });
  });
});
