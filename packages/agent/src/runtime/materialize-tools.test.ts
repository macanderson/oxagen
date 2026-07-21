import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

// Fixed capability fixture: one non-agent (excluded), one low-risk agent,
// one high-risk agent, one non-agent.* agent-surface capability (form.fill).
const FIXTURE = [
  {
    name: "create_org",
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
    name: "fill_form",
    description: "fill a form with AI-proposed values",
    surfaces: ["agent"] as const,
    agent: { riskLevel: "low" as const },
    input: z.object({ formId: z.string(), values: z.record(z.unknown()) }),
  },
  {
    // Sandbox-exec family member — only materializes when isSandboxAvailable()
    // is true, so it is filtered out of the default (sandbox-off) tool set and
    // never perturbs the exact-set assertions above. The model-facing output
    // clip is exercised against it in its own describe block below.
    // (execute_code is the ONE model-facing survivor of the family — the
    // durable session tools are Workbench-only, asserted below.)
    name: "execute_code",
    description: "run code in an ephemeral sandbox",
    surfaces: ["agent"] as const,
    agent: { riskLevel: "low" as const },
    input: z.object({ command: z.string() }),
  },
  {
    // Durable sandbox session tool — Workbench/human-only. NEVER materialized
    // as an LLM tool, even with a driver configured (the model editing files
    // through a self-started session was the defect this policy fixes).
    name: "run_sandbox_command",
    description: "run a command in a durable sandbox session",
    surfaces: ["agent"] as const,
    agent: { riskLevel: "low" as const },
    input: z.object({ command: z.string() }),
  },
];

vi.mock("@oxagen/oxagen", () => ({
  listCapabilities: () => FIXTURE,
  getSurfaces: (c: { surfaces?: readonly string[] }) =>
    c.surfaces ?? ["api", "mcp"],
  getCapability: () => undefined,
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
      // OXA-820: soft-delete column the contributor now filters on.
      deletedAt: "mcp.deletedAt",
      healthStatus: "mcp.healthStatus",
      orgListingId: "mcp.orgListingId",
      id: "mcp.id",
      publicId: "mcp.publicId",
      name: "mcp.name",
      endpointUrl: "mcp.endpointUrl",
      authStrategy: "mcp.authStrategy",
      authConfig: "mcp.authConfig",
    },
    pluginInstalledPlugins: {
      id: "listing.id",
      enabled: "listing.enabled",
      deletedAt: "listing.deletedAt",
      authKind: "listing.authKind",
    },
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
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(dbMocks.db()),
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
  listEntitledCapabilityPluginIds: vi.fn(
    async (_orgId: string, _workspaceId: string) => new Set<string>(),
  ),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: vi.fn(async () => ({ ok: true })),
  authorizeExternalCapability: vi.fn(async () => ({
    allowed: true,
    outcome: "allow",
    reason: null,
  })),
}));

// Agent RBAC (spec §3.5): keep the pure resolver REAL (the filter's behavior
// is exercised end-to-end against actual role-grant resolution), but wrap
// resolveAgentRunCapability in a spy so the tests can prove the filter reads
// the EXACT cached resolution object (reference equality on the second
// argument) — the "one resolution, two readers" invariant.
vi.mock("@oxagen/oxagen/iam", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/iam")>();
  return {
    ...real,
    resolveAgentRunCapability: vi.fn(real.resolveAgentRunCapability),
  };
});

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
    constructor(msg?: string) {
      super(msg ?? "Unauthorized");
      this.name = "UnauthorizedError";
    }
  },
}));

// Stub the MCP network seams; materializePinnedMcpTools stays real so the
// descriptor-pinning contribution path is exercised end-to-end.
vi.mock("../dispatch/mcp-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../dispatch/mcp-client")>();
  return {
    ...real,
    connectMcp: vi.fn(async () => ({})),
    listMcpToolDescriptors: vi.fn(async () => []),
  };
});

// Descriptor-pin I/O seams (pure diff/hash helpers stay real). With no pins on
// record and a succeeding capture, the contributor trust-on-first-use pins the
// live listing — so tools flow through exactly as before pinning existed.
vi.mock("./mcp-snapshots", async (importOriginal) => {
  const real = await importOriginal<typeof import("./mcp-snapshots")>();
  return {
    ...real,
    readLatestPinnedDescriptors: vi.fn(async () => []),
    captureToolSnapshots: vi.fn(async () => 0),
    recordServerChange: vi.fn(async () => undefined),
  };
});

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

// Consent gate (OXA-816). checkConsent/recordConsent are spied so we can drive
// first-use prompt / pre-grant-inline / denial-short-circuit paths.
const consentMocks = vi.hoisted(() => ({
  checkConsent: vi.fn(
    async (): Promise<{
      status: "granted" | "denied";
      active: boolean;
    } | null> => null,
  ),
  recordConsent: vi.fn(async () => ({ consentId: "mcons_x" })),
}));
vi.mock("./consent", () => ({
  checkConsent: consentMocks.checkConsent,
  recordConsent: consentMocks.recordConsent,
  DEFAULT_CONSENT_TTL_MS: 30 * 24 * 60 * 60 * 1000,
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertToolInvocation: mocks.insertToolInvocation,
  };
});

// Agent RBAC Phase 4a: mcp-rbac.ts emits IAM audit rows (ClickHouse) for MCP
// rule denials/ask-escalations — spy the emitter so tests can assert the
// agent-principal rows without a ClickHouse client. (mcp-rbac.ts is the only
// module in this file's import graph that touches @oxagen/iam.)
const iamMocks = vi.hoisted(() => ({
  emitAudit: vi.fn(async () => undefined),
}));
vi.mock("@oxagen/iam", () => ({
  emitAudit: iamMocks.emitAudit,
}));

import { materializeTools } from "./materialize-tools";
import { invoke, authorizeExternalCapability } from "@oxagen/oxagen/kernel";
import {
  createAgentRunResolution,
  resolveAgentRunCapability,
  type AgentAuthzSnapshot,
  type AgentRunIAMContext,
  type AgentRunIAMResolution,
} from "@oxagen/oxagen/iam";
import { isSandboxAvailable } from "@oxagen/sandbox";
import { connectMcp, listMcpToolDescriptors } from "../dispatch/mcp-client";
import { listEntitledCapabilityPluginIds } from "@oxagen/plugins";
import { pluginForContract } from "@oxagen/oxagen/plugins";
// Note: the @oxagen/database `db` is driven via `dbMocks.db` (hoisted above) —
// we do not import the banned raw `db` symbol directly into the test.

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

describe("materializeTools", () => {
  beforeEach(() => {
    dbMocks.rowsByTable.clear();
    vi.mocked(invoke).mockClear();
    vi.mocked(authorizeExternalCapability).mockClear();
    vi.mocked(authorizeExternalCapability).mockResolvedValue({
      allowed: true,
      outcome: "allow",
      reason: null,
    });
    mocks.insertToolInvocation.mockClear();
    mocks.insertToolInvocation.mockResolvedValue(undefined);
  });

  it("returns only agent-surfaced capabilities, keyed by model-safe names", async () => {
    // Capability names are verb-first snake_case (already model-safe: ^[a-zA-Z0-9_-]+$);
    // so the gateway accepts them; undotted names (capA/capB) pass through.
    const { tools } = await materializeTools(CTX);
    expect(Object.keys(tools).sort()).toEqual(["capA", "capB", "fill_form"]);
    expect(tools["create_org"]).toBeUndefined();
  });

  it("maps every model-safe tool name back to its real capability name", async () => {
    const { nameMap } = await materializeTools(CTX);
    expect(nameMap["fill_form"]).toBe("fill_form");
    expect(nameMap["capA"]).toBe("capA");
    // No alias may contain a dot — that is the whole point of the sanitizer.
    for (const alias of Object.keys(nameMap)) {
      expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    }
  });

  it("filters by allowlist", async () => {
    const { tools } = await materializeTools(CTX, {
      allowlist: new Set(["capA"]),
    });
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
    const t = tools.capA as {
      description?: string;
      inputSchema?: unknown;
      execute?: (i: unknown) => Promise<unknown>;
    };
    expect(t.description).toBe("low risk agent cap");
    expect(t.inputSchema).toBeDefined();
    expect(typeof t.execute).toBe("function");
    await t.execute!({ x: "hello" });
    expect(invoke).toHaveBeenCalledWith("capA", { x: "hello" }, CTX, {
      surface: "agent",
    });
  });

  it("fires before/after hooks around a successful invocation", async () => {
    mocks.beforeTool.mockClear();
    mocks.afterTool.mockClear();
    mocks.onError.mockClear();
    const { tools } = await materializeTools(CTX);
    await (
      tools.capA as unknown as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ x: "hi" });
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
      (
        tools.capA as unknown as { execute: (i: unknown) => Promise<unknown> }
      ).execute({ x: "hi" }),
    ).rejects.toThrow("boom");
    expect(mocks.beforeTool).toHaveBeenCalledTimes(1);
    expect(mocks.afterTool).not.toHaveBeenCalled();
    expect(mocks.onError).toHaveBeenCalledTimes(1);
  });

  it("requests approval when requiresApproval+messageId, blocks until approved", async () => {
    mocks.createApprovalRequest.mockClear();
    mocks.waitForApproval.mockClear();
    const fixtureGated = [
      {
        ...FIXTURE[2],
        agent: { riskLevel: "high" as const, requiresApproval: true },
      },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) =>
        c.surfaces ?? ["api", "mcp"],
      getCapability: () => undefined,
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const { tools } = await mt({ ...CTX, messageId: "msg_42" });
    await (
      tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ y: 1 });
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
      {
        ...FIXTURE[2],
        agent: { riskLevel: "high" as const, requiresApproval: true },
      },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) =>
        c.surfaces ?? ["api", "mcp"],
      getCapability: () => undefined,
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const { tools } = await mt({ ...CTX, messageId: "msg_42" });
    await expect(
      (
        tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }
      ).execute({ y: 1 }),
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
    const formFillTool = tools["fill_form"] as {
      execute?: (i: unknown) => Promise<unknown>;
    };
    expect(formFillTool).toBeDefined();
    const result = await formFillTool.execute!({
      formId: "workspace-general",
      values: { name: "Prod" },
    });
    // Kernel invoke must have been called — not the agent-internal loader
    expect(invoke).toHaveBeenCalledWith(
      "fill_form",
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
        name: "generate_svg",
        description: "generate an svg",
        surfaces: ["agent"] as const,
        agent: { riskLevel: "low" as const },
        input: z.object({ prompt: z.string() }),
      },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => customFixture,
      getSurfaces: (c: { surfaces?: readonly string[] }) =>
        c.surfaces ?? ["api", "mcp"],
      getCapability: () => undefined,
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const { tools } = await mt(CTX);
    const svgTool = tools["generate_svg"] as {
      execute?: (i: unknown) => Promise<unknown>;
    };
    expect(svgTool).toBeDefined();
    const result = await svgTool.execute!({ prompt: "a red circle" });
    expect(invoke).toHaveBeenCalledWith(
      "generate_svg",
      { prompt: "a red circle" },
      CTX,
      { surface: "agent" },
    );
    expect(result).toEqual({ svg: "<svg/>" });
  });

  it("no messageId → no approval request (direct MCP/API path)", async () => {
    mocks.createApprovalRequest.mockClear();
    const fixtureGated = [
      {
        ...FIXTURE[2],
        agent: { riskLevel: "high" as const, requiresApproval: true },
      },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) =>
        c.surfaces ?? ["api", "mcp"],
      getCapability: () => undefined,
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const { tools } = await mt({ ...CTX, messageId: null });
    await (
      tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ y: 1 });
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
      {
        ...FIXTURE[2],
        agent: { riskLevel: "high" as const, requiresApproval: true },
      },
    ];
    vi.doMock("@oxagen/oxagen", () => ({
      listCapabilities: () => fixtureGated,
      getSurfaces: (c: { surfaces?: readonly string[] }) =>
        c.surfaces ?? ["api", "mcp"],
      getCapability: () => undefined,
    }));
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");
    const { tools } = await mt({ ...CTX, messageId: "msg_42" });
    await (
      tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ y: 1 });
    expect(mocks.createApprovalRequest).toHaveBeenCalledTimes(1);
    // The approval write saw an active scope carrying the turn's tenant ids.
    expect(scopeAtApproval).toEqual({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    });
    // And the scope is unwound afterwards (no leak across tool calls).
    expect(tenancyMock.state.current).toBeNull();
    // Restore the shared default impl for subsequent tests.
    mocks.createApprovalRequest.mockImplementation(async () => ({
      approvalId: "appr_x",
    }));
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

  // The transport spy: the real materializePinnedMcpTools executes via the MCP
  // client's callTool, so "the transport ran" now means fakeExecute was called.
  const fakeExecute = vi.fn(async () => ({ content: { data: "result" } }));

  beforeEach(() => {
    vi.mocked(authorizeExternalCapability).mockClear();
    vi.mocked(authorizeExternalCapability).mockResolvedValue({
      allowed: true,
      outcome: "allow",
      reason: null,
    });
    fakeExecute.mockClear();
    mocks.insertToolInvocation.mockClear();
    mocks.insertToolInvocation.mockResolvedValue(undefined);

    // Inject one healthy install row for the join query; denylist stays empty.
    dbMocks.rowsByTable.clear();
    dbMocks.rowsByTable.set(dbMocks.schema.mcpServers, [MCP_SERVER]);

    // connectMcp returns a stub client whose callTool is the transport spy; the
    // live listing carries one tool, trust-on-first-use pinned by the contributor
    // (readLatestPinnedDescriptors is mocked to [] above).
    vi.mocked(connectMcp).mockResolvedValue({
      callTool: fakeExecute,
    } as unknown as Awaited<ReturnType<typeof connectMcp>>);
    vi.mocked(listMcpToolDescriptors).mockResolvedValue([
      {
        name: "list_pull_requests",
        description: "List PRs",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("calls authorizeExternalCapability with the per-tool synthetic id before the transport (GAP-4)", async () => {
    const { tools } = await materializeTools(CTX);
    const toolAlias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    const t = tools[toolAlias] as {
      execute?: (i: unknown) => Promise<unknown>;
    };
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
    await (tools[toolAlias] as { execute?: (i: unknown) => Promise<unknown> })
      .execute!({});
    expect(scopeAtIam).toEqual({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    });
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
    const t = tools[toolAlias] as {
      execute?: (i: unknown) => Promise<unknown>;
    };
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
    const t = tools[toolAlias] as {
      execute?: (i: unknown) => Promise<unknown>;
    };
    await t.execute!({});
    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    // vi.fn() mock.calls has an inferred tuple type that TypeScript tightens
    // to [] in hoisted mocks. Cast through unknown to access the call arg.
    const call = (
      mocks.insertToolInvocation.mock.calls[0] as unknown as [unknown]
    )?.[0] as Record<string, unknown>;
    expect(call.status).toBe("failed");
    expect(call.error_class).toBe("IamDenied");
    expect(call.capability_name).toBe(
      `mcp.${MCP_SERVER.id}.list_pull_requests`,
    );
    expect(call.external_server_id).toBe(MCP_SERVER.id);
  });

  it("meters a successful invocation as status=completed (allowed path unchanged)", async () => {
    const { tools } = await materializeTools(CTX);
    const toolAlias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    const t = tools[toolAlias] as {
      execute?: (i: unknown) => Promise<unknown>;
    };
    await t.execute!({});
    expect(fakeExecute).toHaveBeenCalledTimes(1);
    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    const call = (
      mocks.insertToolInvocation.mock.calls[0] as unknown as [unknown]
    )?.[0] as Record<string, unknown>;
    expect(call.status).toBe("completed");
    expect(call.capability_name).toBe(
      `mcp.${MCP_SERVER.id}.list_pull_requests`,
    );
  });

  it("uses defaultEffect=allow for MCP tools (user intentionally registered the server)", async () => {
    const { tools } = await materializeTools(CTX);
    const toolAlias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    await (tools[toolAlias] as { execute?: (i: unknown) => Promise<unknown> })
      .execute!({});
    const [capName, , defaultEffect] = (vi.mocked(authorizeExternalCapability)
      .mock.calls[0] ?? []) as [string, unknown, string];
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
    const { tools } = await materializeTools(CTX, {
      serverAllowlist: new Set(["mcs_abc"]),
    });
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
    const mod = (await import(
      "./plugin-type"
    )) as typeof import("./plugin-type") & {
      __spyContributor?: { contributeTools: ReturnType<typeof vi.fn> };
    };
    const allowlist = new Set(["mcs_x1", "mcs_x2"]);
    await mt(CTX, { serverAllowlist: allowlist });
    expect(mod.__spyContributor?.contributeTools).toHaveBeenCalledWith(CTX, {
      serverAllowlist: allowlist,
    });
  });
});

// ── First-use consent gate (OXA-816) ─────────────────────────────────────────
// These tests verify the external-MCP consent gate runs AFTER the IAM gate and
// BEFORE the transport: a first-use call (no grant) solicits consent + blocks;
// a denied grant short-circuits; a pre-existing grant runs inline.
describe("materializeTools — first-use consent gate (OXA-816)", () => {
  const MCP_SERVER = {
    id: "srv_abc",
    name: "GitHub",
    orgId: "ten_1",
    workspaceId: "ws_1",
    endpointUrl: "https://github.mcp.example.com",
    authStrategy: "bearer",
    authConfig: { token: "tok_test" },
    healthStatus: "healthy",
    authKind: "secret",
  };
  // Transport spy — the real materializePinnedMcpTools executes via callTool.
  const fakeExecute = vi.fn(async () => ({ content: { data: "result" } }));
  // Chat surface: messageId + userId present so the consent gate is active.
  const CHAT_CTX = { ...CTX, messageId: "msg_42", userId: "u_1" };

  beforeEach(() => {
    vi.mocked(authorizeExternalCapability).mockClear();
    vi.mocked(authorizeExternalCapability).mockResolvedValue({
      allowed: true,
      outcome: "allow",
      reason: null,
    });
    fakeExecute.mockClear();
    mocks.insertToolInvocation.mockClear();
    mocks.insertToolInvocation.mockResolvedValue(undefined);
    mocks.createApprovalRequest.mockClear();
    mocks.createApprovalRequest.mockResolvedValue({
      approvalId: "appr_consent",
    });
    mocks.waitForApproval.mockClear();
    mocks.waitForApproval.mockResolvedValue({
      approvalId: "appr_consent",
      resolution: "approved",
      note: null,
    });
    consentMocks.checkConsent.mockClear();
    consentMocks.checkConsent.mockResolvedValue(null);
    consentMocks.recordConsent.mockClear();
    consentMocks.recordConsent.mockResolvedValue({ consentId: "mcons_x" });

    dbMocks.rowsByTable.clear();
    dbMocks.rowsByTable.set(dbMocks.schema.mcpServers, [MCP_SERVER]);
    vi.mocked(connectMcp).mockResolvedValue({
      callTool: fakeExecute,
    } as unknown as Awaited<ReturnType<typeof connectMcp>>);
    vi.mocked(listMcpToolDescriptors).mockResolvedValue([
      {
        name: "list_pull_requests",
        description: "List PRs",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("first-use call with no grant solicits consent, blocks, then records + runs on approval", async () => {
    const events: Array<{
      approvalId: string;
      serverId: string;
      toolName: string;
    }> = [];
    const { tools } = await materializeTools(CHAT_CTX, {
      onConsentRequired: (e) =>
        events.push({
          approvalId: e.approvalId,
          serverId: e.serverId,
          toolName: e.toolName,
        }),
    });
    const alias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    await (tools[alias] as { execute?: (i: unknown) => Promise<unknown> })
      .execute!({});
    // The consent check ran, an approval row was created, and the event fired.
    expect(consentMocks.checkConsent).toHaveBeenCalledWith(
      CHAT_CTX,
      "u_1",
      MCP_SERVER.id,
      "list_pull_requests",
    );
    expect(mocks.createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(mocks.waitForApproval).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        approvalId: "appr_consent",
        serverId: MCP_SERVER.id,
        toolName: "list_pull_requests",
      },
    ]);
    // The grant was persisted and the transport ran on approval.
    expect(consentMocks.recordConsent).toHaveBeenCalledTimes(1);
    expect(
      (
        consentMocks.recordConsent.mock.calls[0] as unknown as [
          { status: string },
        ]
      )[0].status,
    ).toBe("granted");
    expect(fakeExecute).toHaveBeenCalledTimes(1);
  });

  it("records denial and blocks the transport when consent is denied at the prompt", async () => {
    mocks.waitForApproval.mockResolvedValueOnce({
      approvalId: "appr_consent",
      resolution: "denied",
      note: null,
    });
    const { tools } = await materializeTools(CHAT_CTX);
    const alias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    const result = await (
      tools[alias] as { execute?: (i: unknown) => Promise<unknown> }
    ).execute!({});
    expect(consentMocks.recordConsent).toHaveBeenCalledTimes(1);
    expect(
      (
        consentMocks.recordConsent.mock.calls[0] as unknown as [
          { status: string },
        ]
      )[0].status,
    ).toBe("denied");
    expect(fakeExecute).not.toHaveBeenCalled();
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/consent denied/i);
  });

  it("short-circuits without prompting when an active denied grant exists", async () => {
    consentMocks.checkConsent.mockResolvedValueOnce({
      status: "denied",
      active: true,
    });
    const { tools } = await materializeTools(CHAT_CTX);
    const alias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    const result = await (
      tools[alias] as { execute?: (i: unknown) => Promise<unknown> }
    ).execute!({});
    // No new prompt, no new record — the existing denial decides it.
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
    expect(consentMocks.recordConsent).not.toHaveBeenCalled();
    expect(fakeExecute).not.toHaveBeenCalled();
    expect(result as string).toMatch(/consent denied/i);
  });

  it("runs inline (no prompt) when an active grant or wildcard pre-grant exists", async () => {
    consentMocks.checkConsent.mockResolvedValueOnce({
      status: "granted",
      active: true,
    });
    const { tools } = await materializeTools(CHAT_CTX);
    const alias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    await (tools[alias] as { execute?: (i: unknown) => Promise<unknown> })
      .execute!({});
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
    expect(consentMocks.recordConsent).not.toHaveBeenCalled();
    expect(fakeExecute).toHaveBeenCalledTimes(1);
  });

  it("skips the consent gate entirely on the direct (no-messageId) path", async () => {
    // CTX has messageId:null — direct API/MCP caller. The gate must not fire.
    const { tools } = await materializeTools(CTX);
    const alias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    await (tools[alias] as { execute?: (i: unknown) => Promise<unknown> })
      .execute!({});
    expect(consentMocks.checkConsent).not.toHaveBeenCalled();
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
    expect(fakeExecute).toHaveBeenCalledTimes(1);
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
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(
      new Set<string>(),
    );
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
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(
      new Set<string>(),
    );
    const { tools } = await materializeTools(CTX);
    expect(tools.capB).toBeUndefined();
    // Builtin capabilities (capA, form.fill) are unaffected.
    expect(tools.capA).toBeDefined();
    expect(tools["fill_form"]).toBeDefined();
  });

  it("leaves builtin capabilities unaffected regardless of entitlement state", async () => {
    // capA and form.fill are builtins (pluginForContract returns undefined for them).
    // capB is plugin-claimed but not entitled.
    vi.mocked(pluginForContract).mockImplementation((name: string) =>
      name === "capB" ? PLUGIN_MANIFEST : undefined,
    );
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(
      new Set<string>(),
    );
    const { tools } = await materializeTools(CTX);
    expect(tools.capA).toBeDefined();
    expect(tools["fill_form"]).toBeDefined();
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
    expect(tools["fill_form"]).toBeDefined();
  });

  it("fetches the entitled set at most once per materializeTools call", async () => {
    // Multiple plugin-claimed capabilities in one call — only one DB fetch.
    const PLUGIN_B = {
      ...PLUGIN_MANIFEST,
      id: "oxagen/other",
      contracts: ["capA"],
    };
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
    expect(listEntitledCapabilityPluginIds).toHaveBeenCalledWith(
      CTX.orgId,
      CTX.workspaceId,
    );
  });
});

// P0 token flood: the sandbox-exec capabilities return RAW stdout/stderr, so a
// `cat bigfile` / verbose test run would stream megabytes into model context.
// materializeTools clips the model-facing envelope (30k stdout / 10k stderr,
// middle-out) at the tool seam — NOT in the handler, which is also driven
// programmatically by ModalSandboxWorkspace and needs the exact, unclipped bytes.
describe("materializeTools — model-facing sandbox output clip (P0 token flood)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    // execute_code only materializes when a sandbox driver is configured.
    vi.mocked(isSandboxAvailable).mockReturnValue(true);
    mocks.insertToolInvocation.mockClear();
    mocks.insertToolInvocation.mockResolvedValue(undefined);
  });
  afterEach(() => {
    // Restore the file-wide default so no other describe sees sandbox-on.
    vi.mocked(isSandboxAvailable).mockReturnValue(false);
  });

  async function runExec(result: unknown): Promise<Record<string, unknown>> {
    vi.mocked(invoke).mockResolvedValueOnce(result);
    const { tools } = await materializeTools(CTX);
    const t = tools["execute_code"] as unknown as {
      execute: (i: unknown) => Promise<unknown>;
    };
    expect(t).toBeDefined();
    return (await t.execute({ command: "cat big" })) as Record<string, unknown>;
  }

  it("clips oversized stdout to the 30k cap, middle-out, with a marker", async () => {
    const huge = "x".repeat(200_000);
    const out = await runExec({
      exitCode: 0,
      stdout: huge,
      stderr: "",
      timedOut: false,
    });
    const stdout = out.stdout as string;
    expect(stdout).toContain("truncated from the middle");
    expect(stdout.length).toBeLessThan(30_500); // ~30k budget + short marker
    // Head + tail preserved (both ends are the same char here, so check length + edges).
    expect(stdout.startsWith("x")).toBe(true);
    expect(stdout.endsWith("x")).toBe(true);
    // Non-clipped fields pass through untouched.
    expect(out.exitCode).toBe(0);
  });

  it("clips oversized stderr to the tighter 10k cap", async () => {
    const hugeErr = "e".repeat(50_000);
    const out = await runExec({
      exitCode: 1,
      stdout: "ok",
      stderr: hugeErr,
      timedOut: false,
    });
    const stderr = out.stderr as string;
    expect(stderr).toContain("truncated from the middle");
    expect(stderr.length).toBeLessThan(10_500);
    expect(out.stdout).toBe("ok"); // small stdout untouched
  });

  it("leaves output under the caps byte-for-byte unchanged", async () => {
    const out = await runExec({
      exitCode: 0,
      stdout: "hello\nworld\n",
      stderr: "warn",
      timedOut: false,
    });
    expect(out.stdout).toBe("hello\nworld\n");
    expect(out.stderr).toBe("warn");
  });

  it("records the PRE-clip output size in tool_invocations telemetry", async () => {
    const huge = "x".repeat(200_000);
    await runExec({ exitCode: 0, stdout: huge, stderr: "", timedOut: false });
    expect(mocks.insertToolInvocation).toHaveBeenCalled();
    // vi.fn() mock.calls tightens to [] in hoisted mocks — cast through unknown
    // to reach the row arg (same pattern as the failure-telemetry test above).
    const row = (
      mocks.insertToolInvocation.mock.calls.at(-1) as unknown as [
        Record<string, unknown>,
      ]
    )[0];
    // Telemetry measured the full ~200k handler output, not the ~30k clipped envelope.
    expect(row.output_size_bytes as number).toBeGreaterThan(100_000);
  });

  it("does not touch a non-sandbox capability's output (even with a stdout field)", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ stdout: "z".repeat(200_000) });
    const { tools } = await materializeTools(CTX);
    const out = (await (
      tools["capA"] as unknown as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ x: "hi" })) as Record<string, unknown>;
    expect((out.stdout as string).length).toBe(200_000); // passthrough, unclipped
  });
});

// Sandbox tool exposure policy: the engine's workspace toolset is the only
// sanctioned way for a model to touch a repository. The durable sandbox
// session/management family is Workbench/human-only (never an LLM tool),
// and the chat route additionally withholds overlapping mutation paths in
// code mode via `excludeCapabilities`.
describe("materializeTools — sandbox tool exposure policy", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(isSandboxAvailable).mockReturnValue(true);
  });
  afterEach(() => {
    vi.mocked(isSandboxAvailable).mockReturnValue(false);
  });

  it("never materializes the Workbench-only sandbox session family, even with a driver configured", async () => {
    const { tools, nameMap } = await materializeTools(CTX);
    // The one model-facing survivor of the family is present…
    expect(tools["execute_code"]).toBeDefined();
    // …but the durable session tool is withheld despite surfaces:["agent"]
    // and an available driver.
    expect(tools["run_sandbox_command"]).toBeUndefined();
    expect(Object.values(nameMap)).not.toContain("run_sandbox_command");
  });

  it("withholds capabilities named in excludeCapabilities (code-mode overlap filter)", async () => {
    const { tools } = await materializeTools(CTX, {
      excludeCapabilities: new Set(["execute_code"]),
    });
    expect(tools["execute_code"]).toBeUndefined();
    // Unrelated capabilities are untouched by the exclusion.
    expect(tools["capA"]).toBeDefined();
  });
});

// ── Agent RBAC model-facing tool filter (spec §3.5, Phase 2b) ───────────────
//
// When the context carries an agent-run IAM context with its once-per-run
// cached resolution, capability tools whose delegation-ceiling outcome is
// DENY are never materialized; require_approval (pending_approval) tools stay
// visible and route to the approval flow at invoke time. The filter must read
// THE cached resolution object — never fetch or fork a second policy — and a
// context without agentRun behaves byte-identically to today.
describe("materializeTools — agent RBAC tool filter (spec §3.5)", () => {
  const AGENT_PRN = "prn_agent_1";
  const HUMAN_PRN = "prn_human_1";

  const agentPrincipal = {
    id: AGENT_PRN,
    kind: "agent" as const,
    orgId: "ten_1",
    workspaceId: "ws_1",
  };
  const humanPrincipal = {
    id: HUMAN_PRN,
    kind: "human" as const,
    orgId: "ten_1",
    workspaceId: "ws_1",
  };

  // Human role: allows every fixture capability (the ceiling under test is
  // the AGENT side; the human side must not be the thing denying).
  const humanRoleGrants = [
    { roleId: "role_human", capabilityId: "capA", effect: "allow" as const },
    { roleId: "role_human", capabilityId: "capB", effect: "allow" as const },
    {
      roleId: "role_human",
      capabilityId: "fill_form",
      effect: "allow" as const,
    },
  ];

  const roles = [
    {
      id: "role_agent",
      name: "Agent Role Under Test",
      scopeKind: "workspace" as const,
      orgId: "ten_1",
      principalIds: [AGENT_PRN],
      isSystemDefault: true,
    },
    {
      id: "role_human",
      name: "Member",
      scopeKind: "workspace" as const,
      orgId: "ten_1",
      principalIds: [HUMAN_PRN],
      isSystemDefault: true,
    },
  ];

  /**
   * Agent-Observer-shaped snapshot: the agent role allows ONLY the read
   * (capA); fill_form carries an explicit deny; capB has no agent grant at
   * all, so it falls to the contract defaultEffect — absent on the fixture,
   * hence the kernel-mirroring "deny" fallback.
   */
  function observerSnapshot(): AgentAuthzSnapshot {
    return {
      grants: [],
      policies: [],
      roles,
      roleGrants: [
        { roleId: "role_agent", capabilityId: "capA", effect: "allow" },
        { roleId: "role_agent", capabilityId: "fill_form", effect: "deny" },
        ...humanRoleGrants,
      ],
    };
  }

  /**
   * Agent-Contributor-shaped snapshot: low/medium mutations allowed
   * (fill_form), reads allowed (capA), and the high-risk capB gated behind
   * require_approval — which must stay VISIBLE.
   */
  function contributorSnapshot(): AgentAuthzSnapshot {
    return {
      grants: [],
      policies: [],
      roles,
      roleGrants: [
        { roleId: "role_agent", capabilityId: "capA", effect: "allow" },
        { roleId: "role_agent", capabilityId: "fill_form", effect: "allow" },
        {
          roleId: "role_agent",
          capabilityId: "capB",
          effect: "require_approval",
        },
        ...humanRoleGrants,
      ],
    };
  }

  function makeAgentRun(
    resolution?: AgentRunIAMResolution,
  ): AgentRunIAMContext {
    const runCtx: AgentRunIAMContext = {
      principalKind: "agent",
      agentPrincipal,
      humanPrincipal,
      agentId: "agt_test",
      runId: "run_test_1",
      parentRunId: null,
    };
    if (resolution !== undefined) runCtx.resolution = resolution;
    return runCtx;
  }

  function ctxWith(agentRun: AgentRunIAMContext): typeof CTX & {
    agentRun: AgentRunIAMContext;
  } {
    return { ...CTX, agentRun };
  }

  beforeEach(() => {
    dbMocks.rowsByTable.clear();
    vi.mocked(resolveAgentRunCapability).mockClear();
  });

  it("Agent Observer: deny-resolved capabilities are never materialized — the model sees no mutation tools", async () => {
    const resolution = createAgentRunResolution(observerSnapshot());
    const { tools } = await materializeTools(ctxWith(makeAgentRun(resolution)));

    expect(Object.keys(tools).sort()).toEqual(["capA"]);
    // Explicit agent-role deny (fill_form) and default-deny fallback (capB —
    // no grant, no contract defaultEffect) are both excluded.
    expect(tools["fill_form"]).toBeUndefined();
    expect(tools["capB"]).toBeUndefined();
  });

  it("Agent Contributor: keeps low/medium mutations AND keeps require_approval tools visible (they route to the approval flow at invoke time)", async () => {
    const resolution = createAgentRunResolution(contributorSnapshot());
    const { tools } = await materializeTools(ctxWith(makeAgentRun(resolution)));

    expect(Object.keys(tools).sort()).toEqual(["capA", "capB", "fill_form"]);
    // capB stayed visible precisely because its outcome is pending_approval,
    // not allow — provable from the shared per-capability memo.
    expect(resolution.byCapability.get("capB")?.outcome).toBe(
      "pending_approval",
    );
    expect(resolution.byCapability.get("fill_form")?.outcome).toBe("allow");
  });

  it("provably derives from the cached resolution: same object by reference, kernel-shared memo, no second fetch or fork", async () => {
    const resolution = createAgentRunResolution(observerSnapshot());
    const agentRun = makeAgentRun(resolution);

    await materializeTools(ctxWith(agentRun));

    // Every per-capability decision was computed against the EXACT resolution
    // object cached on the run context — reference equality, not a copy, not
    // a re-fetch (materialize-tools has no snapshot fetcher to call).
    const calls = vi.mocked(resolveAgentRunCapability).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[0]).toBe(agentRun);
      expect(call[1]).toBe(resolution);
      // The kernel's defaultEffect fallback is mirrored exactly: fixture
      // capabilities declare no defaultEffect, so the filter resolves "deny".
      expect(call[2]).toMatchObject({ defaultEffect: "deny" });
    }
    // The cache slot was never replaced or forked…
    expect(agentRun.resolution).toBe(resolution);
    // …and the memo the kernel reads at invoke time now holds these exact
    // decisions: a later resolution of the same capability is a Map lookup
    // returning the same object.
    const memoized = resolution.byCapability.get("capA");
    expect(memoized).toBeDefined();
    await materializeTools(ctxWith(agentRun));
    expect(resolution.byCapability.get("capA")).toBe(memoized);
  });

  it("fails closed when agentRun is present WITHOUT a populated resolution: no capability tools at all", async () => {
    const { tools, mutatingToolNames } = await materializeTools(
      ctxWith(makeAgentRun(undefined)),
    );
    expect(Object.keys(tools)).toEqual([]);
    expect(mutatingToolNames).toEqual([]);
    // Fail-closed means NOT resolving — there is no resolution to read.
    expect(vi.mocked(resolveAgentRunCapability)).not.toHaveBeenCalled();
  });

  it("no agentRun on the context → byte-identical to today: full tool set, resolver never consulted", async () => {
    const { tools } = await materializeTools(CTX);
    expect(Object.keys(tools).sort()).toEqual(["capA", "capB", "fill_form"]);
    expect(vi.mocked(resolveAgentRunCapability)).not.toHaveBeenCalled();
  });
});

// ── Agent RBAC Phase 4a: MCP rule enforcement (spec §3.7) ────────────────────
// The run's effective resourceScope.mcp rules ({pattern: "server:tool" glob,
// effect: allow|deny|ask}, first-match-wins) govern external MCP tools at TWO
// seams: listing (deny → never registered, the model cannot SEE it) and
// execution (deny → blocked + audited even if the tool somehow reached the
// model; ask → the existing mcp_consents flow with the AGENT PRINCIPAL as the
// consent subject). No agentRun → both seams inert (the OXA-816 user-consent
// tests above prove the unchanged paths).
describe("materializeTools — agent RBAC MCP rules (Phase 4a, spec §3.7)", () => {
  const AGENT_PRN = "prn_agent_1";
  const HUMAN_PRN = "prn_human_1";
  const MCP_SERVER = {
    id: "srv_abc",
    name: "GitHub", // display-cased — rules address the lowercase name
    orgId: "ten_1",
    workspaceId: "ws_1",
    endpointUrl: "https://github.mcp.example.com",
    authStrategy: "bearer",
    authConfig: { token: "tok_test" },
    healthStatus: "healthy",
    authKind: "secret",
  };
  const ALIAS = `mcp_${MCP_SERVER.id}_list_pull_requests`;
  const SYNTHETIC = `mcp.${MCP_SERVER.id}.list_pull_requests`;
  const fakeExecute = vi.fn(async () => ({ content: { data: "result" } }));

  const roles = [
    {
      id: "role_agent",
      name: "Agent Role Under Test",
      scopeKind: "workspace" as const,
      orgId: "ten_1",
      principalIds: [AGENT_PRN],
      isSystemDefault: true,
    },
    {
      id: "role_human",
      name: "Member",
      scopeKind: "workspace" as const,
      orgId: "ten_1",
      principalIds: [HUMAN_PRN],
      isSystemDefault: true,
    },
  ];

  /** Snapshot whose agent role carries the given resourceScope.mcp rules. */
  function mcpRulesSnapshot(
    rules: Array<{ pattern: string; effect: "allow" | "deny" | "ask" }>,
  ): AgentAuthzSnapshot {
    return {
      grants: [],
      policies: [],
      roles,
      roleGrants: [
        {
          roleId: "role_agent",
          capabilityId: "capA",
          effect: "allow",
          conditionsJsonb: { resourceScope: { mcp: { rules } } },
        },
        { roleId: "role_human", capabilityId: "capA", effect: "allow" },
      ],
    };
  }

  function makeMcpAgentRun(
    rules: Array<{ pattern: string; effect: "allow" | "deny" | "ask" }>,
  ): AgentRunIAMContext {
    const runCtx: AgentRunIAMContext = {
      principalKind: "agent",
      agentPrincipal: {
        id: AGENT_PRN,
        kind: "agent",
        orgId: "ten_1",
        workspaceId: "ws_1",
      },
      humanPrincipal: {
        id: HUMAN_PRN,
        kind: "human",
        orgId: "ten_1",
        workspaceId: "ws_1",
      },
      agentId: "agt_test",
      runId: "run_test_1",
      parentRunId: null,
    };
    runCtx.resolution = createAgentRunResolution(mcpRulesSnapshot(rules));
    return runCtx;
  }

  beforeEach(() => {
    vi.mocked(authorizeExternalCapability).mockClear();
    vi.mocked(authorizeExternalCapability).mockResolvedValue({
      allowed: true,
      outcome: "allow",
      reason: null,
    });
    fakeExecute.mockClear();
    mocks.insertToolInvocation.mockClear();
    mocks.insertToolInvocation.mockResolvedValue(undefined);
    mocks.createApprovalRequest.mockClear();
    mocks.createApprovalRequest.mockResolvedValue({ approvalId: "appr_ask" });
    mocks.waitForApproval.mockClear();
    mocks.waitForApproval.mockResolvedValue({
      approvalId: "appr_ask",
      resolution: "approved",
      note: null,
    });
    consentMocks.checkConsent.mockClear();
    consentMocks.checkConsent.mockResolvedValue(null);
    consentMocks.recordConsent.mockClear();
    consentMocks.recordConsent.mockResolvedValue({ consentId: "mcons_x" });
    iamMocks.emitAudit.mockClear();
    iamMocks.emitAudit.mockResolvedValue(undefined);

    dbMocks.rowsByTable.clear();
    dbMocks.rowsByTable.set(dbMocks.schema.mcpServers, [MCP_SERVER]);
    vi.mocked(connectMcp).mockResolvedValue({
      callTool: fakeExecute,
    } as unknown as Awaited<ReturnType<typeof connectMcp>>);
    vi.mocked(listMcpToolDescriptors).mockResolvedValue([
      {
        name: "list_pull_requests",
        description: "List PRs",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("listing: an agent whose rules deny github:* cannot SEE github tools (unbound turn still can)", async () => {
    // Baseline: the unbound turn lists the tool.
    const unbound = await materializeTools(CTX);
    expect(unbound.tools[ALIAS]).toBeDefined();

    // Same workspace, agent run with a blanket github deny → tool never
    // registered. Rule addresses the lowercase server name; the row is
    // display-cased "GitHub" — case-insensitivity is enforced end-to-end.
    const bound = await materializeTools({
      ...CTX,
      agentRun: makeMcpAgentRun([{ pattern: "github:*", effect: "deny" }]),
    });
    expect(bound.tools[ALIAS]).toBeUndefined();
  });

  it("listing: first-match-wins — an earlier specific allow survives a later blanket deny", async () => {
    const { tools } = await materializeTools({
      ...CTX,
      agentRun: makeMcpAgentRun([
        { pattern: "github:list_*", effect: "allow" },
        { pattern: "github:*", effect: "deny" },
      ]),
    });
    expect(tools[ALIAS]).toBeDefined();
    // Flip the order and the blanket deny decides first — the tool vanishes.
    const flipped = await materializeTools({
      ...CTX,
      agentRun: makeMcpAgentRun([
        { pattern: "github:*", effect: "deny" },
        { pattern: "github:list_*", effect: "allow" },
      ]),
    });
    expect(flipped.tools[ALIAS]).toBeUndefined();
  });

  it("listing: ask-ruled tools STAY visible (consent governs at call time), and fail-closed hides everything", async () => {
    const asked = await materializeTools({
      ...CTX,
      agentRun: makeMcpAgentRun([{ pattern: "github:*", effect: "ask" }]),
    });
    expect(asked.tools[ALIAS]).toBeDefined();

    // agentRun WITHOUT a resolution → fail closed for MCP tools too.
    const bare: AgentRunIAMContext = {
      principalKind: "agent",
      agentPrincipal: {
        id: AGENT_PRN,
        kind: "agent",
        orgId: "ten_1",
        workspaceId: "ws_1",
      },
      humanPrincipal: null,
      agentId: "agt_test",
      runId: "run_test_2",
    };
    const closed = await materializeTools({ ...CTX, agentRun: bare });
    expect(closed.tools[ALIAS]).toBeUndefined();
  });

  it("execution: deny blocks the CALL even when the tool was materialized before the rules bound — audited with the agent principal and server:tool dimension", async () => {
    // Materialize UNBOUND (tool visible), then attach the agent run to the
    // same ctx object — the real ordering hazard: resolution slots are
    // written by the run's first IAM check, which may postdate tool
    // materialization. The execute closure reads ctx.agentRun at CALL time.
    const ctx: typeof CTX & { agentRun?: AgentRunIAMContext } = { ...CTX };
    const { tools } = await materializeTools(ctx);
    expect(tools[ALIAS]).toBeDefined();

    ctx.agentRun = makeMcpAgentRun([{ pattern: "github:*", effect: "deny" }]);
    const result = await (
      tools[ALIAS] as { execute?: (i: unknown) => Promise<unknown> }
    ).execute!({});

    // Transport never ran; the model got a readable block string.
    expect(fakeExecute).not.toHaveBeenCalled();
    expect(result as string).toMatch(/agent role policy/i);
    expect(result as string).toContain("github:list_pull_requests");

    // Audit: existing IAM event, agent principal (→ principal_kind='agent'),
    // server:tool as the target dimension, run lineage attached.
    expect(iamMocks.emitAudit).toHaveBeenCalledTimes(1);
    const audit = (
      iamMocks.emitAudit.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0];
    expect(audit.capability).toBe(SYNTHETIC);
    expect(audit.principal).toMatchObject({ id: AGENT_PRN, kind: "agent" });
    expect(audit.target).toEqual({
      kind: "mcp_tool",
      id: "github:list_pull_requests",
    });
    expect((audit.result as { outcome: string }).outcome).toBe("deny");
    expect(audit.runLineage).toMatchObject({
      agentId: "agt_test",
      runId: "run_test_1",
    });

    // Metered as a failed invocation with the rule-denial error class.
    expect(mocks.insertToolInvocation).toHaveBeenCalledTimes(1);
    const meter = (
      mocks.insertToolInvocation.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ]
    )[0];
    expect(meter.status).toBe("failed");
    expect(meter.error_class).toBe("McpRuleDenied");
  });

  it("execution: a call under agentRun WITHOUT a resolution fails closed", async () => {
    const ctx: typeof CTX & { agentRun?: AgentRunIAMContext } = { ...CTX };
    const { tools } = await materializeTools(ctx);
    ctx.agentRun = {
      principalKind: "agent",
      agentPrincipal: {
        id: AGENT_PRN,
        kind: "agent",
        orgId: "ten_1",
        workspaceId: "ws_1",
      },
      humanPrincipal: null,
      agentId: "agt_test",
      runId: "run_test_3",
    };
    const result = await (
      tools[ALIAS] as { execute?: (i: unknown) => Promise<unknown> }
    ).execute!({});
    expect(fakeExecute).not.toHaveBeenCalled();
    expect(result as string).toMatch(/no IAM resolution/i);
  });

  it("ask: routes through the EXISTING consent flow with the AGENT PRINCIPAL as subject (subject_kind='agent'), skipping the user-scoped gate", async () => {
    const events: Array<{ approvalId: string }> = [];
    const ctx = {
      ...CTX,
      messageId: "msg_ask", // interactive surface — the card can render
      agentRun: makeMcpAgentRun([{ pattern: "github:*", effect: "ask" }]),
    };
    const { tools } = await materializeTools(ctx, {
      onConsentRequired: (e) => events.push({ approvalId: e.approvalId }),
    });
    const result = await (
      tools[ALIAS] as { execute?: (i: unknown) => Promise<unknown> }
    ).execute!({});

    // Consent lookup used the AGENT subject: principal id + "agent" kind —
    // and it is the ONLY consent lookup (the user-scoped gate was skipped).
    expect(consentMocks.checkConsent).toHaveBeenCalledTimes(1);
    expect(consentMocks.checkConsent).toHaveBeenCalledWith(
      ctx,
      AGENT_PRN,
      MCP_SERVER.id,
      "list_pull_requests",
      "agent",
    );
    // The HITL card machinery ran and the durable grant recorded the agent
    // principal as the subject with the distinct label.
    expect(events).toEqual([{ approvalId: "appr_ask" }]);
    expect(consentMocks.recordConsent).toHaveBeenCalledTimes(1);
    expect(
      (
        consentMocks.recordConsent.mock.calls[0] as unknown as [
          Record<string, unknown>,
        ]
      )[0],
    ).toMatchObject({
      userId: AGENT_PRN,
      subjectKind: "agent",
      serverId: MCP_SERVER.id,
      toolName: "list_pull_requests",
      status: "granted",
    });
    // Ask-escalation audited as pending_approval.
    expect(iamMocks.emitAudit).toHaveBeenCalledTimes(1);
    expect(
      (
        iamMocks.emitAudit.mock.calls[0] as unknown as [
          { result: { outcome: string } },
        ]
      )[0].result.outcome,
    ).toBe("pending_approval");
    // Approved → the transport ran.
    expect(fakeExecute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: "result" });
  });

  it("ask: an active agent-subject grant runs inline — no card, no audit, no user gate", async () => {
    consentMocks.checkConsent.mockResolvedValueOnce({
      status: "granted",
      active: true,
    });
    const ctx = {
      ...CTX,
      messageId: "msg_ask2",
      agentRun: makeMcpAgentRun([{ pattern: "github:*", effect: "ask" }]),
    };
    const { tools } = await materializeTools(ctx);
    await (tools[ALIAS] as { execute?: (i: unknown) => Promise<unknown> })
      .execute!({});
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
    expect(iamMocks.emitAudit).not.toHaveBeenCalled();
    expect(consentMocks.checkConsent).toHaveBeenCalledTimes(1);
    expect(fakeExecute).toHaveBeenCalledTimes(1);
  });

  it("ask: unattended surface (no messageId) fails closed without writing a consent row", async () => {
    const ctx = {
      ...CTX, // messageId: null — durable runner turn
      agentRun: makeMcpAgentRun([{ pattern: "github:*", effect: "ask" }]),
    };
    const { tools } = await materializeTools(ctx);
    const result = await (
      tools[ALIAS] as { execute?: (i: unknown) => Promise<unknown> }
    ).execute!({});
    expect(fakeExecute).not.toHaveBeenCalled();
    expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
    expect(consentMocks.recordConsent).not.toHaveBeenCalled();
    expect(result as string).toMatch(/consent required/i);
    // The escalation is still audited.
    expect(iamMocks.emitAudit).toHaveBeenCalledTimes(1);
  });

  it("allow-ruled and unruled agent runs execute unchanged (rules only bind where written)", async () => {
    const ctx = {
      ...CTX,
      agentRun: makeMcpAgentRun([{ pattern: "github:*", effect: "allow" }]),
    };
    const { tools } = await materializeTools(ctx);
    const result = await (
      tools[ALIAS] as { execute?: (i: unknown) => Promise<unknown> }
    ).execute!({});
    expect(fakeExecute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: "result" });
    expect(iamMocks.emitAudit).not.toHaveBeenCalled();
  });
});
