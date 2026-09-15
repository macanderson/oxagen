// The agent writes through the real kernel seam: the viewer resolution and the
// kernel's invoke() are the only fakes, so each case shows what the person gets
// back and whether the capability ran — ok, invalid (refused before the kernel)
// and denied for every action (INV-19).
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
const {
  commitAgentDefinition,
  retireAgent,
  rotateAgentCredential,
  setAgentSuspended,
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
});

const AT = "2026-09-15T09:00:00.000Z";
/** The CapabilityContext every write reaches the kernel with. */
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};
const denied = (name: string) =>
  new kernel.CapabilityError(name, "authz_denied", "denied");

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("rotateAgentCredential", () => {
  it("rotates for the workspace viewer and returns the new secret once", async () => {
    invoke.mockResolvedValue({
      agentId: "agt_releasebot",
      revokedCredentialId: "aky_1",
      credential: { id: "aky_2", secret: "oxa_ag_s3cr3t", expiresAt: AT },
    });
    expect(
      await rotateAgentCredential("acme", "core-platform", "agt_releasebot"),
    ).toEqual({ ok: true, value: { secret: "oxa_ag_s3cr3t", expiresAt: AT } });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "rotate_agent_credential",
      { agentId: "agt_releasebot" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an empty agent before the kernel runs (negative)", async () => {
    expect(await rotateAgentCredential("acme", "core-platform", "")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "agentId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("rotate_agent_credential"));
    expect(
      await rotateAgentCredential("acme", "core-platform", "agt_releasebot"),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("setAgentSuspended", () => {
  it("suspends, and resumes with suspended false", async () => {
    invoke.mockResolvedValueOnce({
      agentId: "agt_releasebot",
      status: "suspended",
      changedAt: AT,
    });
    expect(
      await setAgentSuspended("acme", "core-platform", "agt_releasebot", true),
    ).toEqual({ ok: true, value: { status: "suspended" } });
    invoke.mockResolvedValueOnce({
      agentId: "agt_releasebot",
      status: "active",
      changedAt: AT,
    });
    expect(
      await setAgentSuspended("acme", "core-platform", "agt_releasebot", false),
    ).toEqual({ ok: true, value: { status: "active" } });
    expect(invoke.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["suspend_agent", { agentId: "agt_releasebot", suspended: true }],
      ["suspend_agent", { agentId: "agt_releasebot", suspended: false }],
    ]);
  });

  it("refuses an agent id longer than the contract allows (negative)", async () => {
    expect(
      await setAgentSuspended("acme", "core-platform", "a".repeat(129), true),
    ).toMatchObject({ ok: false, reason: "invalid", field: "agentId" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("suspend_agent"));
    expect(
      await setAgentSuspended("acme", "core-platform", "agt_releasebot", true),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("retireAgent", () => {
  it("retires the agent and returns when", async () => {
    invoke.mockResolvedValue({
      agentId: "agt_releasebot",
      status: "retired",
      revokedCredentials: 1,
      revokedHosts: 2,
      retiredAt: AT,
    });
    expect(
      await retireAgent("acme", "core-platform", "agt_releasebot"),
    ).toEqual({ ok: true, value: { retiredAt: AT } });
    expect(invoke).toHaveBeenCalledWith(
      "retire_agent",
      { agentId: "agt_releasebot" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an empty agent before the kernel runs (negative)", async () => {
    expect(await retireAgent("acme", "core-platform", "")).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "agentId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("retire_agent"));
    expect(
      await retireAgent("acme", "core-platform", "agt_releasebot"),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("commitAgentDefinition", () => {
  const draft = {
    agentId: "agt_releasebot",
    branch: " agents/release-bot ",
    message: " Light tier ",
    source: 'slug = "release-bot"\n',
  };

  it("commits the trimmed branch and message with the file as written, and returns the pull request", async () => {
    invoke.mockResolvedValue({
      agentId: "agt_releasebot",
      version: 2,
      path: ".oxagen/agents/release-bot.toml",
      digest: "b".repeat(64),
      commitSha: "4d5e6f7",
      branch: "agents/release-bot",
      pullRequest: { number: 12, url: "https://github.com/acme/core/pull/12" },
    });
    expect(await commitAgentDefinition("acme", "core-platform", draft)).toEqual(
      {
        ok: true,
        value: {
          branch: "agents/release-bot",
          commitSha: "4d5e6f7",
          pullRequest: {
            number: 12,
            url: "https://github.com/acme/core/pull/12",
          },
        },
      },
    );
    expect(invoke).toHaveBeenCalledWith(
      "commit_agent_definition",
      {
        agentId: "agt_releasebot",
        branch: "agents/release-bot",
        message: "Light tier",
        source: 'slug = "release-bot"\n',
      },
      expect.objectContaining(TENANT),
    );
  });

  it("leaves a blank message to the handler", async () => {
    invoke.mockRejectedValue(denied("commit_agent_definition"));
    await commitAgentDefinition("acme", "core-platform", {
      ...draft,
      message: "   ",
    });
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      agentId: "agt_releasebot",
      branch: "agents/release-bot",
      source: 'slug = "release-bot"\n',
    });
  });

  it.each([
    ["a qualified ref", { branch: "refs/heads/main" }, "branch"],
    ["an empty file", { source: "" }, "source"],
  ])(
    "refuses %s before the kernel runs (negative)",
    async (_what, change, field) => {
      expect(
        await commitAgentDefinition("acme", "core-platform", {
          ...draft,
          ...change,
        }),
      ).toEqual({ ok: false, reason: "invalid", code: "invalid_input", field });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("commit_agent_definition"));
    expect(
      await commitAgentDefinition("acme", "core-platform", draft),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("a person the workspace refuses", () => {
  it.each([
    [
      "rotateAgentCredential",
      () => rotateAgentCredential("acme", "x", "agt_a"),
    ],
    ["setAgentSuspended", () => setAgentSuspended("acme", "x", "agt_a", true)],
    ["retireAgent", () => retireAgent("acme", "x", "agt_a")],
    [
      "commitAgentDefinition",
      () =>
        commitAgentDefinition("acme", "x", {
          agentId: "agt_a",
          branch: "b",
          message: "",
          source: "s",
        }),
    ],
  ])("%s runs nothing (negative)", async (_name, run) => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(invoke).not.toHaveBeenCalled();
  });
});
