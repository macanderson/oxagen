// Studio's Review actions through the real kernel seam (#4678, item 6). The
// viewer resolution and the kernel's invoke() are the only fakes, so each
// case shows what the Changes tab gets back and what the capability was sent:
// the saved draft, the stored draft, the opened steering PR, and a refusal
// with the handler's reason as its code (INV-19).
import type { StudioDraftOp } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
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
const { getStudioDraftAction, openStudioReviewAction, saveStudioDraftAction } =
  await import("./actions");

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

const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};

const IMPORT_VOID: StudioDraftOp = { kind: "import", tool: "void_invoice" };
const CLASSIFY_REFUND: StudioDraftOp = {
  kind: "classify",
  tool: "create_refund",
  risk: "critical",
  sideEffect: "irreversible",
  egress: "org_tenant",
  impacts: ["moves_money"],
};

/** The billing draft as get_studio_draft and save_studio_draft answer it. */
const DRAFT = {
  server: "billing",
  serverId: "mcs_01k5s1",
  ops: [IMPORT_VOID, CLASSIFY_REFUND],
  serverToml: null,
  source: { type: "openapi", bytes: 52_000 },
  revision: 3,
  pr: null,
  updatedAt: "2026-09-28T09:00:00.000Z",
};

/** The steering PR open_studio_review answers. */
const REVIEW = {
  number: 4721,
  url: "https://github.com/acme/steering/pull/4721",
  branch: "tools/billing",
  headSha: "0f3c2a1b9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a",
  imported: ["void_invoice"],
  removed: [],
  reclassified: [
    {
      tool: "create_refund",
      before: {
        risk: "medium",
        sideEffect: "write",
        egress: "org_tenant",
        impacts: [],
      },
      after: {
        risk: "critical",
        sideEffect: "irreversible",
        egress: "org_tenant",
        impacts: ["moves_money"],
      },
    },
  ],
  tokens: { definitions: 1_150, budget: 8_000 },
  findings: [],
};

const refused = (
  code: "forbidden" | "not_found" | "conflict",
  reason: string,
) => new kernel.HandlerError({ code, reason });

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("saveStudioDraftAction", () => {
  it("saves the edits over the revision they build on and answers the stored draft", async () => {
    invoke.mockResolvedValue(DRAFT);
    expect(
      await saveStudioDraftAction("acme", "core-platform", {
        server: "billing",
        serverId: "mcs_01k5s1",
        ops: [IMPORT_VOID, CLASSIFY_REFUND],
        revision: 2,
      }),
    ).toEqual({ ok: true, value: DRAFT });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "save_studio_draft",
      expect.anything(),
      expect.objectContaining(TENANT),
    );
    // The browser sends neither server.toml nor the definition.
    expect(invoke.mock.calls[0]?.[1]).toStrictEqual({
      server: "billing",
      serverId: "mcs_01k5s1",
      ops: [IMPORT_VOID, CLASSIFY_REFUND],
      revision: 2,
    });
  });

  it("leaves the server id out for a server with no registry row", async () => {
    invoke.mockResolvedValue({ ...DRAFT, server: "scratch", serverId: null });
    await saveStudioDraftAction("acme", "core-platform", {
      server: "scratch",
      ops: [IMPORT_VOID],
      revision: 0,
    });
    expect(invoke.mock.calls[0]?.[1]).toStrictEqual({
      server: "scratch",
      ops: [IMPORT_VOID],
      revision: 0,
    });
  });

  it("answers a stale revision as a conflict with the handler's reason", async () => {
    invoke.mockRejectedValue(refused("conflict", "draft_revision_stale"));
    expect(
      await saveStudioDraftAction("acme", "core-platform", {
        server: "billing",
        ops: [IMPORT_VOID],
        revision: 2,
      }),
    ).toEqual({ ok: false, reason: "conflict", code: "draft_revision_stale" });
  });

  it("answers the role gate's refusal with its reason", async () => {
    invoke.mockRejectedValue(refused("forbidden", "org_role_required"));
    expect(
      await saveStudioDraftAction("acme", "core-platform", {
        server: "billing",
        ops: [IMPORT_VOID],
        revision: 2,
      }),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });

  it("is refused before the kernel when the server name breaks the folder rule", async () => {
    expect(
      await saveStudioDraftAction("acme", "core-platform", {
        server: "Billing Server",
        ops: [IMPORT_VOID],
        revision: 0,
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "server",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("getStudioDraftAction", () => {
  it("reads the server's stored draft", async () => {
    invoke.mockResolvedValue({ draft: DRAFT });
    expect(
      await getStudioDraftAction("acme", "core-platform", "billing"),
    ).toEqual({ ok: true, value: { draft: DRAFT } });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "get_studio_draft",
      { server: "billing" },
      expect.objectContaining(TENANT),
    );
  });

  it("answers null when the server has no stored draft", async () => {
    invoke.mockResolvedValue({ draft: null });
    expect(
      await getStudioDraftAction("acme", "core-platform", "scratch"),
    ).toEqual({ ok: true, value: { draft: null } });
  });

  it("keeps the handler's reason when the server is not in the workspace", async () => {
    invoke.mockRejectedValue(refused("not_found", "server_not_found"));
    expect(
      await getStudioDraftAction("acme", "core-platform", "billing"),
    ).toEqual({ ok: false, reason: "not_found", code: "server_not_found" });
  });

  it("reports a refused read with the permission the Tools page names", async () => {
    invoke.mockRejectedValue(refused("forbidden", "org_role_required"));
    expect(
      await getStudioDraftAction("acme", "core-platform", "billing"),
    ).toEqual({ ok: false, reason: "denied", code: "tools.read" });
  });
});

describe("openStudioReviewAction", () => {
  it("opens the steering PR from the saved revision", async () => {
    invoke.mockResolvedValue(REVIEW);
    expect(
      await openStudioReviewAction("acme", "core-platform", {
        server: "billing",
        revision: 3,
      }),
    ).toEqual({ ok: true, value: REVIEW });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "open_studio_review",
      { server: "billing", revision: 3 },
      expect.objectContaining(TENANT),
    );
  });

  it("answers an unclassified import with the handler's reason", async () => {
    invoke.mockRejectedValue(refused("conflict", "tools_unclassified"));
    expect(
      await openStudioReviewAction("acme", "core-platform", {
        server: "billing",
        revision: 3,
      }),
    ).toEqual({ ok: false, reason: "conflict", code: "tools_unclassified" });
  });

  it("answers a newer stored draft as a stale revision", async () => {
    invoke.mockRejectedValue(refused("conflict", "draft_revision_stale"));
    expect(
      await openStudioReviewAction("acme", "core-platform", {
        server: "billing",
        revision: 3,
      }),
    ).toEqual({ ok: false, reason: "conflict", code: "draft_revision_stale" });
  });
});
