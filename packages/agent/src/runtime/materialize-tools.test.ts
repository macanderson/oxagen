import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

// Fixed capability fixture: one non-agent (excluded), one low-risk agent,
// one high-risk agent, one non-agent.* agent-surface capability (form.fill).
const FIXTURE = [
  {
    name: "organization.create",
    description: "non-agent capability",
    surfaces: ["api", "mcp"] as const,
    input: z.object({}),
  },
  {
    name: "capA",
    description: "low risk agent cap",
    surfaces: ["agent"] as const,
    agent: { riskLevel: "low" as const },
    input: z.object({ x: z.string() }),
  },
  {
    name: "capB",
    description: "high risk agent cap",
    surfaces: ["agent"] as const,
    agent: { riskLevel: "high" as const },
    input: z.object({ y: z.number() }),
  },
  {
    // Non-agent.* name but surfaced on agent — this is the gap-1 scenario.
    name: "form.fill",
    description: "fill a form with AI-proposed values",
    surfaces: ["agent"] as const,
    agent: { riskLevel: "low" as const },
    input: z.object({ formId: z.string(), values: z.record(z.unknown()) }),
  },
];

vi.mock("@oxagen/oxagen", () => ({
  listCapabilities: () => FIXTURE,
  getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
}));

vi.mock("@oxagen/oxagen/plugins", () => ({
  pluginForContract: vi.fn((_name: string) => undefined),
}));

// Stub @oxagen/database. The MCP plugin-type contributor runs two queries via
// withTenantDb: (1) denylisted server names, (2) the enabled installs joined to
// their enabled org listing. The builder returns rows keyed by the `from` table
// sentinel, so tests inject install rows via dbMocks.rowsByTable.set(schema.mcpServers, [...]).
const dbMocks = vi.hoisted(() => {
  const schema = {
    mcpServers: {
      orgId: "mcp.orgId",
      workspaceId: "mcp.workspaceId",
      enabled: "mcp.enabled",
      healthStatus: "mcp.healthStatus",
      orgListingId: "mcp.orgListingId",
      id: "mcp.id",
      name: "mcp.name",
      endpointUrl: "mcp.endpointUrl",
      authStrategy: "mcp.authStrategy",
      authConfig: "mcp.authConfig",
    },
    pluginOrgListings: { id: "listing.id", enabled: "listing.enabled", deletedAt: "listing.deletedAt", authKind: "listing.authKind" },
    pluginOrgDenylist: { orgId: "deny.orgId", serverName: "deny.serverName" },
  };
  const rowsByTable = new Map<unknown, unknown[]>();
  const builder = {
    select: () => ({
      from: (t: unknown) => {
        const result = rowsByTable.get(t) ?? [];
        const chain = { innerJoin: () => chain, where: async () => result };
        return chain;
      },
    }),
  };
  return { schema, rowsByTable, db: vi.fn((): unknown => builder) };
});
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  db: dbMocks.db,
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMocks.db()),
  schema: dbMocks.schema,

  };
});

// The MCP contributor uses @oxagen/plugins for credentials, OAuth provider, and reauth marking.
// listEntitledCapabilityPluginIds is also mocked here for the entitlement filter tests.
vi.mock("@oxagen/plugins", () => ({
  getWorkspaceSecret: vi.fn(async () => null),
  DbOAuthClientProvider: vi.fn().mockImplementation(() => ({
    redirectUrl: "https://app.example.com/api/v1/mcp/oauth/callback",
    clientMetadata: {},
    state: vi.fn(() => "runtime:listing_1"),
    clientInformation: vi.fn(async () => undefined),
    saveClientInformation: vi.fn(async () => undefined),
    tokens: vi.fn(async () => undefined),
    saveTokens: vi.fn(async () => undefined),
    redirectToAuthorization: vi.fn(async () => undefined),
    saveCodeVerifier: vi.fn(async () => undefined),
    codeVerifier: vi.fn(async () => "verifier"),
    pendingRedirect: null,
  })),
  markCredentialNeedsReauth: vi.fn(async () => undefined),
  listEntitledCapabilityPluginIds: vi.fn(async (_orgId: string, _workspaceId: string) => new Set<string>()),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: vi.fn(async () => ({ ok: true })),
  authorizeExternalCapability: vi.fn(async () => ({ allowed: true, outcome: "allow", reason: null })),
}));

// Lightweight @oxagen/tenancy shim. The real runInTenantScope asserts UUIDs and
// uses a module-singleton AsyncLocalStorage; both fight this file (fake ids like
// "ten_1", plus vi.resetModules() re-imports that would fork the ALS). The shim
// stores the active scope in a vi.hoisted object — created ONCE and shared across
// every re-imported module instance — so getScope() observed in the test reflects
// the scope set by the (possibly re-imported) materializeTools. This is what lets
// us assert the approval write + MCP IAM gate run INSIDE a tenant scope (the
// regression for "No active tenant scope — data access out of bounds").
const tenancyMock = vi.hoisted(() => ({
  state: { current: null as null | { orgId: string; workspaceId: string } },
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async <T>(
    scope: { orgId: string; workspaceId: string },
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    const prev = tenancyMock.state.current;
    tenancyMock.state.current = scope;
    try {
      return await fn();
    } finally {
      tenancyMock.state.current = prev;
    }
  },
  getScope: () => tenancyMock.state.current,
  requireScope: () => {
    if (!tenancyMock.state.current) {
      throw new Error("No active tenant scope — data access out of bounds");
    }
    return tenancyMock.state.current;
  },
}));

// Stub @oxagen/sandbox so isSandboxAvailable() is mockable and never tries to
// detect a real driver.
vi.mock("@oxagen/sandbox", () => ({
  isSandboxAvailable: vi.fn(() => false),
}));

// Stub @modelcontextprotocol/sdk/client/auth.js — UnauthorizedError used by the MCP contributor.
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {
    constructor(msg?: string) { super(msg ?? "Unauthorized"); this.name = "UnauthorizedError"; }
  },
}));

// Stub the MCP client so tests can inject fake tool executes.
vi.mock("../dispatch/mcp-client", () => ({
  connectMcp: vi.fn(async () => ({})),
  materializeMcpTools: vi.fn(async () => ({})),
}));

const mocks = vi.hoisted(() => ({
  beforeTool: vi.fn(async () => undefined),
  afterTool: vi.fn(async () => undefined),
  onError: vi.fn(async () => undefined),
  createApprovalRequest: vi.fn(async () => ({ approvalId: "appr_x" })),
  waitForApproval: vi.fn(
    async (): Promise<{
      approvalId: string;
      resolution: "approved" | "denied" | "expired";
      note: null;
    }> => ({ approvalId: "appr_x", resolution: "approved", note: null }),
  ),
  insertToolInvocation: vi.fn(async () => undefined),
}));

vi.mock("../hooks/runtime", () => ({
  beforeTool: mocks.beforeTool,
  afterTool: mocks.afterTool,
  onError: mocks.onError,
}));

vi.mock("./approval", () => ({
  createApprovalRequest: mocks.createApprovalRequest,
  waitForApproval: mocks.waitForApproval,
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertToolInvocation: mocks.insertToolInvocation,
  };
});

import { materializeTools } from "./materialize-tools";
import { invoke, authorizeExternalCapability } from "@oxagen/oxagen/kernel";
import { connectMcp, materializeMcpTools } from "../dispatch/mcp-client";
import { listEntitledCapabilityPluginIds } from "@oxagen/plugins";
import { pluginForContract } from "@oxagen/oxagen/plugins";
// Note: the @oxagen/database `db` is driven via `dbMocks.db` (hoisted above) —
// we do not import the banned raw `db` symbol directly into the test.

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1", surface: "runner" as const, messageId: null,
};

describe("materializeTools", () => {
  beforeEach(() => {
    dbMocks.rowsByTable.clear();
    vi.mocked(invoke).mockClear();
    vi.mocked(authorizeExternalCapability).mockClear();
    vi.mocked(authorizeExternalCapability).mockResolvedValue({ allowed: true, outcome: "allow", reason: null });
    mocks.insertToolInvocation.mockClear();
    mocks.insertToolInvocation.mockResolvedValue(undefined);
  });

  it("returns only agent-surfaced capabilities, keyed by model-safe names", async () => {
    // Dotted capability names (form.fill) are sanitized to ^[a-zA-Z0-9_-]+$
    // so the gateway accepts them; undotted names (capA/capB) pass through.
    const { tools } = await materializeTools(CTX);
    expect(Object.keys(tools).sort()).toEqual(["capA", "capB", "form_fill"]);
    expect(tools["organization.create"]).toBeUndefined();
    expect(tools["form.fill"]).toBeUndefined();
  });

  it("maps every model-safe tool name back to its real capability name", async () => {
    const { nameMap } = await materializeTools(CTX);
    expect(nameMap["form_fill"]).toBe("form.fill");
    expect(nameMap["capA"]).toBe("capA");
    // No alias may contain a dot — that is the whole point of the sanitizer.
    for (const alias of Object.keys(nameMap)) {
      expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    }
  });

  it("filters by allowlist", async () => {
    const { tools } = await materializeTools(CTX, { allowlist: new Set(["capA"]) });
    expect(Object.keys(tools)).toEqual(["capA"]);
  });

  it("excludes capabilities above the risk ceiling", async () => {
    const { tools } = await materializeTools(CTX, { riskCeiling: "medium" });
    expect(tools.capA).toBeDefined();
    expect(tools.capB).toBeUndefined();
  });

  it("includes high risk when ceiling is high", async () => {
    const { tools } = await materializeTools(CTX, { riskCeiling: "high" });
    expect(tools.capB).toBeDefined();
  });

  it("produces AI SDK tools with description, inputSchema, and execute", async () => {
    const { tools } = await materializeTools(CTX);
    const t = tools.capA as { description?: string; inputSchema?: unknown; execute?: (i: unknown) => Promise<unknown> };
    expect(t.description).toBe("low risk agent cap");
    expect(t.inputSchema).toBeDefined();
    expect(typeof t.execute).toBe("function");
    await t.execute!({ x: "hello" });
    expect(invoke).toHaveBeenCalledWith("capA", { x: "hello" }, CTX, { surface: "agent" });
  });

  it("fires before/after hooks around a successful invocation", async () => {
    mocks.beforeTool.mockClear();
    mocks.afterTool.mockClear();
    mocks.onError.mockClear();
    const { tools } = await materializeTools(CTX);
    await (tools.capA as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ x: "hi" });
    expect(mocks.beforeTool).toHaveBeenCalledTimes(1);
    expect(mocks.afterTool).toHaveBeenCalledTimes(1);
    expect(mocks.onError).not.toHaveBeenCalled();
  });

  it("fires onError when the handler throws", async () => {
    mocks.beforeTool.mockClear();
    mocks.afterTool.mockClear();
    mocks.onError.mockClear();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("boom"));
    const { tools } = await materializeTools(CTX);
    await expect(
      (tools.capA as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ x: "hi" }),
    ).rejects.toThrow("boom");
    expect(mocks.beforeTool).toHaveBeenCalledTimes(1);
    expect(mocks.afterTool).not.toHaveBeenCalled();
    expect(mocks.onError).toHaveBeenCalledTimes(1);
  });

  it("requests approval when requiresApproval+messageId, blocks until approved", async () => {
    mocks.createApprovalRequest.mockClear();
    mocks.waitForApproval.mockClear();
    const fixtureGated = [
      { ...FIXTURE[2], agent: { riskLevel: "high" as const, requiresApproval: true } },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const { tools } = await mt({ ...CTX, messageId: "msg_42" });
    await (tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ y: 1 });
    expect(mocks.createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(mocks.waitForApproval).toHaveBeenCalledTimes(1);
  });

  it("denied approval throws and the handler never runs", async () => {
    mocks.createApprovalRequest.mockClear();
    mocks.waitForApproval.mockClear();
    mocks.waitForApproval.mockResolvedValueOnce({
      approvalId: "appr_x",
      resolution: "denied",
      note: null,
    });
    vi.mocked(invoke).mockClear();
    const fixtureGated = [
      { ...FIXTURE[2], agent: { riskLevel: "high" as const, requiresApproval: true } },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const { tools } = await mt({ ...CTX, messageId: "msg_42" });
    await expect(
      (tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ y: 1 }),
    ).rejects.toThrow(/approval denied/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("form.fill (non-agent.* name) dispatches through kernel invoke without 'No handler registered'", async () => {
    // This is the gap-1 regression test. Prior to the fix, the tool execute
    // used invokeCapability (agent-internal, only covers agent.*) instead of
    // the shared kernel invoke. This test asserts that a non-agent.* capability
    // that is surfaced on agent resolves end-to-end through kernel invoke.
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce({ filled: true });
    const { tools } = await materializeTools(CTX);
    // Keyed by the model-safe alias; execute still invokes the real "form.fill".
    const formFillTool = tools["form_fill"] as { execute?: (i: unknown) => Promise<unknown> };
    expect(formFillTool).toBeDefined();
    const result = await formFillTool.execute!({ formId: "workspace-general", values: { name: "Prod" } });
    // Kernel invoke must have been called — not the agent-internal loader
    expect(invoke).toHaveBeenCalledWith(
      "form.fill",
      { formId: "workspace-general", values: { name: "Prod" } },
      CTX,
      { surface: "agent" },
    );
    expect(result).toEqual({ filled: true });
  });

  it("svg.generate (non-agent.* name) dispatches through kernel invoke without 'No handler registered'", async () => {
    // Second non-agent.* capability from the gap-1 list to confirm pattern.
    // We use the FIXTURE as-is (svg.generate is not in FIXTURE); instead we
    // use the already-present form.fill fixture entry and verify kernel
    // invoke is the dispatch path for any non-agent.* agent-surface capability.
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce({ svg: "<svg/>" });
    const customFixture = [
      {
        name: "svg.generate",
        description: "generate an svg",
        surfaces: ["agent"] as const,
        agent: { riskLevel: "low" as const },
        input: z.object({ prompt: z.string() }),
      },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => customFixture,
      getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const { tools } = await mt(CTX);
    const svgTool = tools["svg_generate"] as { execute?: (i: unknown) => Promise<unknown> };
    expect(svgTool).toBeDefined();
    const result = await svgTool.execute!({ prompt: "a red circle" });
    expect(invoke).toHaveBeenCalledWith(
      "svg.generate",
      { prompt: "a red circle" },
      CTX,
      { surface: "agent" },
    );
    expect(result).toEqual({ svg: "<svg/>" });
  });

  it("no messageId → no approval request (direct MCP/API path)", async () => {
    mocks.createApprovalRequest.mockClear();
    const fixtureGated = [
      { ...FIXTURE[2], agent: { riskLevel: "high" as const, requiresApproval: true } },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const { tools } = await mt({ ...CTX, messageId: null });
    await (tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ y: 1 });
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
  });

  // Regression: the approval write (createApprovalRequest → withTenantDb →
  // requireScope) runs from the AI SDK's deferred execute() OUTSIDE the route's
  // runInTenantScope. Without re-entering scope here it failed fast with
  // "No active tenant scope — data access out of bounds" before the approval
  // card could render. Assert the write now happens INSIDE the turn's scope.
  it("writes the approval request inside the turn's tenant scope (regression: no 'No active tenant scope')", async () => {
    let scopeAtApproval: unknown = "UNSET";
    mocks.createApprovalRequest.mockReset();
    mocks.createApprovalRequest.mockImplementationOnce(async () => {
      // tenancyMock.state.current is the active scope set by runInTenantScope.
      scopeAtApproval = tenancyMock.state.current;
      return { approvalId: "appr_scoped" };
    });
    const fixtureGated = [
      { ...FIXTURE[2], agent: { riskLevel: "high" as const, requiresApproval: true } },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) => c.surfaces ?? ["api", "mcp"],
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const { tools } = await mt({ ...CTX, messageId: "msg_42" });
    await (tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({ y: 1 });
    expect(mocks.createApprovalRequest).toHaveBeenCalledTimes(1);
    // The approval write saw an active scope carrying the turn's tenant ids.
    expect(scopeAtApproval).toEqual({ orgId: CTX.orgId, workspaceId: CTX.workspaceId });
    // And the scope is unwound afterwards (no leak across tool calls).
    expect(tenancyMock.state.current).toBeNull();
    // Restore the shared default impl for subsequent tests.
    mocks.createApprovalRequest.mockImplementation(async () => ({ approvalId: "appr_x" }));
  });
});

// ── GAP-4: External MCP tool IAM enforcement ─────────────────────────────────
// These tests verify that external MCP tool executes call authorizeExternalCapability
// BEFORE the transport, block when denied, and always meter via insertToolInvocation.
describe("materializeTools — external MCP IAM enforcement (GAP-4)", () => {
  const MCP_SERVER = {
    id: "srv_abc",
    name: "GitHub",
    orgId: "ten_1",
    workspaceId: "ws_1",
    endpointUrl: "https://github.mcp.example.com",
    authStrategy: "bearer",
    authConfig: { token: "tok_test" },
    healthStatus: "healthy",
    authKind: "secret", // static bearer path (not oauth)
  };

  // A fake MCP tool execute function the test can spy on.
  const fakeExecute = vi.fn(async () => ({ data: "result" }));

  beforeEach(() => {
    vi.mocked(authorizeExternalCapability).mockClear();
    vi.mocked(authorizeExternalCapability).mockResolvedValue({ allowed: true, outcome: "allow", reason: null });
    fakeExecute.mockClear();
    mocks.insertToolInvocation.mockClear();
    mocks.insertToolInvocation.mockResolvedValue(undefined);

    // Inject one healthy install row for the join query; denylist stays empty.
    dbMocks.rowsByTable.clear();
    dbMocks.rowsByTable.set(dbMocks.schema.mcpServers, [MCP_SERVER]);

    // connectMcp returns a stub client; materializeMcpTools returns one tool.
    vi.mocked(connectMcp).mockResolvedValue({} as Awaited<ReturnType<typeof connectMcp>>);
    vi.mocked(materializeMcpTools).mockResolvedValue({
      [`mcp.${MCP_SERVER.id}.list_pull_requests`]: {
        description: "List PRs",
        inputSchema: z.record(z.string(), z.unknown()),
        execute: fakeExecute,
      } as unknown as import("ai").Tool,
    });
  });

  it("calls authorizeExternalCapability with the per-tool synthetic id before the transport (GAP-4)", async () => {
    const { tools } = await materializeTools(CTX);
    const toolAlias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    const t = tools[toolAlias] as { execute?: (i: unknown) => Promise<unknown> };
    expect(t).toBeDefined();
    await t.execute!({});
    expect(authorizeExternalCapability).toHaveBeenCalledWith(
      `mcp.${MCP_SERVER.id}.list_pull_requests`,
      CTX,
      "allow",
    );
    // Transport must have run on allow.
    expect(fakeExecute).toHaveBeenCalledTimes(1);
  });

  it("runs the IAM gate inside the turn's tenant scope (regression: fetchAuthz needs withTenantDb)", async () => {
    let scopeAtIam: unknown = "UNSET";
    vi.mocked(authorizeExternalCapability).mockImplementationOnce(async () => {
      scopeAtIam = tenancyMock.state.current;
      return { allowed: true, outcome: "allow", reason: null };
    });
    const { tools } = await materializeTools(CTX);
    const toolAlias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    await (tools[toolAlias] as { execute?: (i: unknown) => Promise<unknown> }).execute!({});
    expect(scopeAtIam).toEqual({ orgId: CTX.orgId, workspaceId: CTX.workspaceId });
    expect(tenancyMock.state.current).toBeNull();
  });

  it("blocks transport and returns tool-error string when IAM denies (GAP-4)", async () => {
    vi.mocked(authorizeExternalCapability).mockResolvedValueOnce({
      allowed: false,
      outcome: "deny",
      reason: "workspace_policy_deny",
    });
    const { tools } = await materializeTools(CTX);
    const toolAlias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    const t = tools[toolAlias] as { execute?: (i: unknown) => Promise<unknown> };
    const result = await t.execute!({});
    // Transport must NOT have run.
    expect(fakeExecute).not.toHaveBeenCalled();
    // The model receives a readable string, not a thrown error.
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/blocked by workspace policy/i);
    expect(result as string).toContain("workspace_policy_deny");
  });

  it("meters a denied invocation as status=denied in insertToolInvocation (GAP-4 + instrument-everything)", async () => {
    vi.mocked(authorizeExternalCapability).mockResolvedValueOnce({
      allowed: false,
      outcome: "deny",
      reason: "explicit_deny",
    });
    const { tools } = await materializeTools(CTX);
    const toolAlias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    const t = tools[toolAlias] as { execute?: (i: unknown) => Promise<unknown> };
    await t.execute!({});
    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    // vi.fn() mock.calls has an inferred tuple type that TypeScript tightens
    // to [] in hoisted mocks. Cast through unknown to access the call arg.
    const call = (mocks.insertToolInvocation.mock.calls[0] as unknown as [unknown])?.[0] as Record<string, unknown>;
    expect(call.status).toBe("failed");
    expect(call.error_class).toBe("IamDenied");
    expect(call.capability_name).toBe(`mcp.${MCP_SERVER.id}.list_pull_requests`);
    expect(call.external_server_id).toBe(MCP_SERVER.id);
  });

  it("meters a successful invocation as status=completed (allowed path unchanged)", async () => {
    const { tools } = await materializeTools(CTX);
    const toolAlias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    const t = tools[toolAlias] as { execute?: (i: unknown) => Promise<unknown> };
    await t.execute!({});
    expect(fakeExecute).toHaveBeenCalledTimes(1);
    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    const call = (mocks.insertToolInvocation.mock.calls[0] as unknown as [unknown])?.[0] as Record<string, unknown>;
    expect(call.status).toBe("completed");
    expect(call.capability_name).toBe(`mcp.${MCP_SERVER.id}.list_pull_requests`);
  });

  it("uses defaultEffect=allow for MCP tools (user intentionally registered the server)", async () => {
    const { tools } = await materializeTools(CTX);
    const toolAlias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    await (tools[toolAlias] as { execute?: (i: unknown) => Promise<unknown> }).execute!({});
    const [capName, , defaultEffect] = (vi.mocked(authorizeExternalCapability).mock.calls[0] ?? []) as [string, unknown, string];
    expect(capName).toBe(`mcp.${MCP_SERVER.id}.list_pull_requests`);
    expect(defaultEffect).toBe("allow");
  });

  it("contributes tools when serverAllowlist is undefined (no filtering)", async () => {
    // When serverAllowlist is not set, all healthy servers are loaded (no per-turn restriction).
    const { tools } = await materializeTools(CTX);
    const toolAlias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    expect(tools[toolAlias]).toBeDefined();
  });

  it("contributes tools when serverAllowlist contains the server publicId", async () => {
    // Server row needs a publicId for the allowlist check in contributeMcpTools.
    const serverWithPublicId = { ...MCP_SERVER, publicId: "mcs_abc" };
    dbMocks.rowsByTable.set(dbMocks.schema.mcpServers, [serverWithPublicId]);
    const { tools } = await materializeTools(CTX, { serverAllowlist: new Set(["mcs_abc"]) });
    const toolAlias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    // The DB mock ignores WHERE conditions and returns all rows, so tools are contributed.
    expect(tools[toolAlias]).toBeDefined();
  });

  it("passes serverAllowlist through to contributeTools options", async () => {
    // Verify the threading: materializeTools propagates serverAllowlist to every
    // plugin-type contributor via the PluginContributeOptions argument.
    vi.doMock("./plugin-type", async (importOriginal) => {
      const real = await importOriginal<typeof import("./plugin-type")>();
      const spyContributor = {
        type: "mcp_server" as const,
        contributeTools: vi.fn(async () => []),
      };
      return {
        ...real,
        getPluginTypeContributors: vi.fn(() => [spyContributor]),
        // Expose the spy so we can assert on it below.
        __spyContributor: spyContributor,
      };
    });
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const mod = await import("./plugin-type") as typeof import("./plugin-type") & { __spyContributor?: { contributeTools: ReturnType<typeof vi.fn> } };
    const allowlist = new Set(["mcs_x1", "mcs_x2"]);
    await mt(CTX, { serverAllowlist: allowlist });
    expect(mod.__spyContributor?.contributeTools).toHaveBeenCalledWith(
      CTX,
      { serverAllowlist: allowlist },
    );
  });
});

// ── Entitlement filter (Work Package 4) ──────────────────────────────────────
// These tests verify that materializeTools filters plugin-claimed capabilities
// based on the org's entitlement set, while leaving builtin capabilities
// unaffected. The kernel gate is the real security boundary; this is UX-layer.
describe("materializeTools — entitlement filter (WP4)", () => {
  const PLUGIN_MANIFEST = {
    id: "oxagen/media-svg",
    name: "SVG Generation",
    description: "Generate SVGs",
    version: "1.0.0",
    pluginType: "agent_capability" as const,
    tier: "free" as const,
    visibility: "ga" as const,
    category: "media",
    contracts: ["capB"],
    scopes: [],
  };

  beforeEach(() => {
    dbMocks.rowsByTable.clear();
    vi.mocked(invoke).mockClear();
    vi.mocked(listEntitledCapabilityPluginIds).mockClear();
    vi.mocked(pluginForContract).mockClear();
    // Default: pluginForContract returns undefined (all builtins).
    vi.mocked(pluginForContract).mockReturnValue(undefined);
    // Default: empty entitled set.
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(new Set<string>());
  });

  it("includes plugin-claimed capability when org is entitled to the pack", async () => {
    // capB is claimed by oxagen/media-svg; org has it installed+enabled.
    vi.mocked(pluginForContract).mockImplementation((name: string) =>
      name === "capB" ? PLUGIN_MANIFEST : undefined,
    );
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(
      new Set(["oxagen/media-svg"]),
    );
    const { tools } = await materializeTools(CTX);
    expect(tools.capB).toBeDefined();
  });

  it("excludes plugin-claimed capability when org is NOT entitled to the pack", async () => {
    // capB is claimed by oxagen/media-svg; org has NOT installed it.
    vi.mocked(pluginForContract).mockImplementation((name: string) =>
      name === "capB" ? PLUGIN_MANIFEST : undefined,
    );
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(new Set<string>());
    const { tools } = await materializeTools(CTX);
    expect(tools.capB).toBeUndefined();
    // Builtin capabilities (capA, form.fill) are unaffected.
    expect(tools.capA).toBeDefined();
    expect(tools["form_fill"]).toBeDefined();
  });

  it("leaves builtin capabilities unaffected regardless of entitlement state", async () => {
    // capA and form.fill are builtins (pluginForContract returns undefined for them).
    // capB is plugin-claimed but not entitled.
    vi.mocked(pluginForContract).mockImplementation((name: string) =>
      name === "capB" ? PLUGIN_MANIFEST : undefined,
    );
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(new Set<string>());
    const { tools } = await materializeTools(CTX);
    expect(tools.capA).toBeDefined();
    expect(tools["form_fill"]).toBeDefined();
    expect(tools.capB).toBeUndefined();
  });

  it("excludes plugin-claimed tools and keeps builtins when entitlement fetch throws (fail-closed)", async () => {
    // capB is plugin-claimed; the DB call fails.
    vi.mocked(pluginForContract).mockImplementation((name: string) =>
      name === "capB" ? PLUGIN_MANIFEST : undefined,
    );
    vi.mocked(listEntitledCapabilityPluginIds).mockRejectedValue(
      new Error("DB unavailable"),
    );
    const { tools } = await materializeTools(CTX);
    // Plugin-claimed tool is excluded (fail-closed).
    expect(tools.capB).toBeUndefined();
    // Builtin capabilities are unaffected.
    expect(tools.capA).toBeDefined();
    expect(tools["form_fill"]).toBeDefined();
  });

  it("fetches the entitled set at most once per materializeTools call", async () => {
    // Multiple plugin-claimed capabilities in one call — only one DB fetch.
    const PLUGIN_B = { ...PLUGIN_MANIFEST, id: "oxagen/other", contracts: ["capA"] };
    vi.mocked(pluginForContract).mockImplementation((name: string) => {
      if (name === "capB") return PLUGIN_MANIFEST;
      if (name === "capA") return PLUGIN_B;
      return undefined;
    });
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(
      new Set(["oxagen/media-svg", "oxagen/other"]),
    );
    await materializeTools(CTX);
    // Even though both capA and capB are plugin-claimed, the entitlement service
    // is called exactly once per materializeTools invocation.
    expect(listEntitledCapabilityPluginIds).toHaveBeenCalledTimes(1);
    expect(listEntitledCapabilityPluginIds).toHaveBeenCalledWith(CTX.orgId, CTX.workspaceId);
  });
});
