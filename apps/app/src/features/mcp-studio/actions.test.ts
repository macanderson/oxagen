// Studio's server actions through the real kernel seam (#4678). The viewer
// resolution and the kernel's invoke() are the only fakes, so each case shows
// what a screen gets back and what the capability was sent: the saved draft,
// the stored draft, the opened steering PR, a discovery, a server's tools and
// findings, a Test call, a drafted description, a stored credential, and a
// refusal with the handler's reason as its code (INV-19).
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
const {
  draftStudioDescriptionAction,
  getStudioDiscoveryAction,
  getStudioDraftAction,
  listStudioFindingsAction,
  listStudioToolsAction,
  openStudioReviewAction,
  saveNewStudioServerAction,
  saveStudioDraftAction,
  setMcpCredentialAction,
  startStudioDiscoveryAction,
  tryStudioToolAction,
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

/** A new OpenAPI server as Add server's From a definition saves it. */
const NEW_SERVER = {
  server: "ledger",
  serverToml: 'schema = "mcp-server/v1"\nname = "ledger"\n',
  source: {
    type: "openapi" as const,
    files: [{ path: "openapi.yaml", text: "openapi: 3.1.0\n" }],
    entry: "openapi.yaml",
  },
};

describe("saveNewStudioServerAction", () => {
  it("saves the first draft at revision 0 with server.toml, the definition, and no edits", async () => {
    invoke.mockResolvedValue({
      ...DRAFT,
      server: "ledger",
      serverId: null,
      ops: [],
      revision: 1,
    });
    const result = await saveNewStudioServerAction("acme", "core-platform", {
      ...NEW_SERVER,
      revision: 0,
    });
    expect(result.ok && result.value.revision).toBe(1);
    expect(invoke).toHaveBeenCalledWith(
      "save_studio_draft",
      expect.anything(),
      expect.objectContaining(TENANT),
    );
    expect(invoke.mock.calls[0]?.[1]).toStrictEqual({
      server: "ledger",
      ops: [],
      serverToml: NEW_SERVER.serverToml,
      source: NEW_SERVER.source,
      revision: 0,
    });
  });

  it("saves a retry at the revision and server id the first save returned", async () => {
    invoke.mockResolvedValue({ ...DRAFT, server: "ledger", ops: [], revision: 2 });
    await saveNewStudioServerAction("acme", "core-platform", {
      ...NEW_SERVER,
      serverId: "mcs_01k5s9",
      revision: 1,
    });
    expect(invoke.mock.calls[0]?.[1]).toStrictEqual({
      server: "ledger",
      serverId: "mcs_01k5s9",
      ops: [],
      serverToml: NEW_SERVER.serverToml,
      source: NEW_SERVER.source,
      revision: 1,
    });
  });

  it("answers a draft already stored under the name as a stale revision", async () => {
    invoke.mockRejectedValue(refused("conflict", "draft_revision_stale"));
    expect(
      await saveNewStudioServerAction("acme", "core-platform", {
        ...NEW_SERVER,
        revision: 0,
      }),
    ).toEqual({ ok: false, reason: "conflict", code: "draft_revision_stale" });
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

/** A discovery start_studio_discovery answers, queued and not yet run. */
const QUEUED = {
  id: "3f1c2b9a-0d4e-4c8b-9a7f-1e2d3c4b5a69",
  server: "billing",
  mcpServerId: "mcs_01k5s1",
  status: "queued",
  trigger: "manual",
  requestedAt: "2026-09-30T06:00:00.000Z",
  requestedBy: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  startedAt: null,
  finishedAt: null,
  error: null,
  outcome: null,
  toolCount: null,
  machine: null,
  sourceKind: "openapi",
  sourceRepo: null,
  sourcePath: null,
  sourceRef: null,
  schedule: "manual",
  upstreamDigest: null,
  latestVersion: null,
  pr: null,
  withheld: [],
  stalled: false,
};

describe("discovery actions", () => {
  it("starts a discovery of the server", async () => {
    invoke.mockResolvedValue({ discovery: QUEUED });
    expect(
      await startStudioDiscoveryAction("acme", "core-platform", "billing"),
    ).toEqual({ ok: true, value: { discovery: QUEUED } });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "start_studio_discovery",
      { server: "billing" },
      expect.objectContaining(TENANT),
    );
  });

  it("reads a server with no discovery yet as null", async () => {
    invoke.mockResolvedValue({ discovery: null });
    expect(
      await getStudioDiscoveryAction("acme", "core-platform", "billing"),
    ).toEqual({ ok: true, value: { discovery: null } });
    expect(invoke).toHaveBeenCalledWith(
      "get_studio_discovery",
      { server: "billing" },
      expect.objectContaining(TENANT),
    );
  });

  it("reads the server's tools", async () => {
    const listed = {
      server: "billing",
      mcpServerId: "mcs_01k5s1",
      snapshotId: null,
      capturedAt: null,
      exposure: { mode: "direct", budget: 8000 },
      tokens: { definitions: null, budget: 8000 },
      imported: 0,
      offered: 0,
      searchRecommended: false,
      compileError: null,
      tools: [],
    };
    invoke.mockResolvedValue(listed);
    expect(
      await listStudioToolsAction("acme", "core-platform", "billing"),
    ).toEqual({ ok: true, value: listed });
    expect(invoke).toHaveBeenCalledWith(
      "list_studio_tools",
      { server: "billing" },
      expect.objectContaining(TENANT),
    );
  });

  it("keeps the handler's reason when the server is not in the workspace", async () => {
    invoke.mockRejectedValue(refused("not_found", "server_not_found"));
    expect(
      await getStudioDiscoveryAction("acme", "core-platform", "billing"),
    ).toEqual({ ok: false, reason: "not_found", code: "server_not_found" });
  });
});

describe("listStudioFindingsAction", () => {
  it("reads the tool checks' findings on the folder", async () => {
    const findings = {
      server: "billing",
      basis: "published",
      revision: null,
      tokens: { definitions: 1200, budget: 8000 },
      findings: [],
    };
    invoke.mockResolvedValue(findings);
    expect(
      await listStudioFindingsAction("acme", "core-platform", "billing"),
    ).toEqual({ ok: true, value: findings });
    expect(invoke).toHaveBeenCalledWith(
      "list_studio_findings",
      { server: "billing" },
      expect.objectContaining(TENANT),
    );
  });
});

describe("tryStudioToolAction", () => {
  it("sends the call and answers the handler's denial as its output", async () => {
    const denied = {
      ok: false,
      reason: "denied",
      message: "Refunds wait for an approver.",
    };
    invoke.mockResolvedValue(denied);
    const input = {
      server: "billing",
      tool: "create_refund",
      environment: "sandbox",
      arguments: { charge: "ch_1", amount: 500 },
    };
    expect(
      await tryStudioToolAction("acme", "core-platform", input),
    ).toEqual({ ok: true, value: denied });
    expect(invoke).toHaveBeenCalledWith(
      "try_studio_tool",
      input,
      expect.objectContaining(TENANT),
    );
  });
});

describe("draftStudioDescriptionAction", () => {
  it("answers the suggestion and saves nothing", async () => {
    const drafted = {
      server: "billing",
      tool: "list_invoices",
      description: "List the invoices of one customer.",
    };
    invoke.mockResolvedValue(drafted);
    expect(
      await draftStudioDescriptionAction("acme", "core-platform", {
        server: "billing",
        tool: "list_invoices",
      }),
    ).toEqual({ ok: true, value: drafted });
    expect(invoke).toHaveBeenCalledWith(
      "draft_studio_description",
      { server: "billing", tool: "list_invoices" },
      expect.objectContaining(TENANT),
    );
  });
});

describe("setMcpCredentialAction", () => {
  it("stores the credential and answers its reference", async () => {
    const stored = {
      name: "stripe-restricted",
      reference: "oxagen:credential/stripe-restricted",
      created: false,
    };
    invoke.mockResolvedValue(stored);
    // Joined at run time, so no secret-shaped literal reaches the repository.
    const secret = ["sk", "test", "4f1c2b"].join("_");
    const input = { name: "stripe-restricted", kind: "secret", secret } as const;
    expect(
      await setMcpCredentialAction("acme", "core-platform", input),
    ).toEqual({ ok: true, value: stored });
    expect(invoke).toHaveBeenCalledWith(
      "set_mcp_credential",
      input,
      expect.objectContaining(TENANT),
    );
  });

  it("answers a caller without the role with the role gate's reason", async () => {
    invoke.mockRejectedValue(refused("forbidden", "org_role_required"));
    const result = await setMcpCredentialAction("acme", "core-platform", {
      name: "stripe-restricted",
      kind: "secret",
      secret: ["sk", "test", "4f1c2b"].join("_"),
    });
    expect(result).toMatchObject({ ok: false, reason: "denied" });
  });
});
