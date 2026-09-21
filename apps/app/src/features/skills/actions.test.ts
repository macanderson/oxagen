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
  proposeSkillConfig,
  publishSkillConfig,
  importSkillConfig,
  previewSkillSearch,
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

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});
describe("skill console actions", () => {
  it("resolves the viewer for each write and sends only the named action", async () => {
    invoke.mockResolvedValue({
      pullRequest: { number: 8, url: "https://github.com/acme/core/pull/8" },
      published: null,
    });
    expect(
      await proposeSkillConfig("acme", "core-platform", "enabled = false\n"),
    ).toMatchObject({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith(
      "update_skill_config",
      { action: "propose", text: "enabled = false\n" },
      expect.objectContaining({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
      }),
    );
    await publishSkillConfig("acme", "core-platform", 8);
    expect(invoke).toHaveBeenLastCalledWith(
      "update_skill_config",
      { action: "publish", pullRequestNumber: 8 },
      expect.anything(),
    );
    await importSkillConfig("acme", "core-platform");
    expect(invoke).toHaveBeenLastCalledWith(
      "update_skill_config",
      { action: "import" },
      expect.anything(),
    );
    expect(requireViewer).toHaveBeenCalledTimes(3);
  });
  it("reads preview only for the selected version and query through the same tenant seam", async () => {
    invoke.mockResolvedValue({
      version: "skl_v3",
      repositoryCommitSha: "a".repeat(40),
      results: [
        {
          id: "code-review",
          version: "1.2.0",
          digest: `sha256:${"b".repeat(64)}`,
          source: "workspace",
          description: "Review a diff",
          tokenCost: 40,
          score: 0.9,
        },
      ],
      withheld: [],
      tokenCost: 40,
    });
    // The candidate's catalogue slug reaches the page as `skillRef`: the view
    // model refuses to name a value Oxagen never minted `id` (INV-11).
    expect(
      await previewSkillSearch("acme", "core-platform", "skl_v3", "review"),
    ).toMatchObject({
      ok: true,
      value: {
        version: "skl_v3",
        results: [{ skillRef: "code-review", version: "1.2.0" }],
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "preview_skill_search",
      { version: "skl_v3", query: "review" },
      expect.objectContaining({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
      }),
    );
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
  });
  it("refuses invalid inputs before invocation and preserves role refusal", async () => {
    expect(await publishSkillConfig("acme", "core-platform", -1)).toMatchObject(
      { ok: false, reason: "invalid" },
    );
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      }),
    );
    expect(
      await proposeSkillConfig("acme", "core-platform", "enabled = true"),
    ).toMatchObject({ ok: false, reason: "denied", code: "org_role_required" });
  });
});
