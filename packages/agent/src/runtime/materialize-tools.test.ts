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
];

const externalRulesFactory = vi.hoisted(() => vi.fn());
const externalRulesMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("./external-tool-rules", () => ({
  externalDecisionCheck: (args: unknown) => {
    externalRulesFactory(args);
    return externalRulesMock;
  },
}));
beforeEach(() => {
  externalRulesMock.mockReset().mockResolvedValue(undefined);
  externalRulesFactory.mockReset();
});

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
      transportType: "mcp.transportType",
      workspaceId: "mcp.workspaceId",
      enabled: "mcp.enabled",
      // soft-delete column the contributor now filters on.
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
        const chain = { leftJoin: () => chain, where: async () => result };
        return chain;
      },
    }),
  };
  return { schema, rowsByTable, db: vi.fn((): unknown => builder) };
});
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    db: dbMocks.db,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(dbMocks.db()),
    schema: dbMocks.schema,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
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

// The kill-switch gate (spec §6.11) is a seam: the default gate reads Postgres
// through withTenantDb, which this file's db double does not model. Tests that
// exercise the gate pass their own through `opts.killSwitchGate`; every other
// test gets a gate that finds every call open, so the fixture registry above
// behaves as an unswitched workspace. The real gate is tested in
// kill-switch-gate.test.ts.
const killSwitchMocks = vi.hoisted(() => ({
  check: vi.fn(
    async (_facts: { capabilityId: string; readOnly: boolean }) =>
      null as unknown,
  ),
  /** The acting agent each gate was created with (its third argument). */
  actingAgents: [] as unknown[],
}));
vi.mock("./kill-switch-gate", async (importOriginal) => {
  const real = await importOriginal<typeof import("./kill-switch-gate")>();
  return {
    ...real,
    createKillSwitchGate: (
      _ctx: unknown,
      _reads?: unknown,
      actingAgent?: unknown,
    ) => {
      killSwitchMocks.actingAgents.push(actingAgent);
      return { check: killSwitchMocks.check };
    },
  };
});

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: vi.fn(async () => ({ ok: true })),
  emitExternalCapabilityOutcome: vi.fn(),
  authorizeExternalCapability: vi.fn(async () => ({
    allowed: true,
    outcome: "allow",
    reason: null,
    decision: null,
  })),
}));

// Governed action billing (ADR-165). The admission gate and the recorder are
// spies; the ledger helpers stay real, so the keys these tests read are the
// keys production writes. Each spy records the tenant scope it ran in, since
// both write or read through withTenantDb.
const billingMocks = vi.hoisted(() => ({
  scopes: [] as Array<{ orgId: string; workspaceId: string } | null>,
  assertGauAvailable: vi.fn(async (_orgId: string): Promise<void> => undefined),
  recordGovernedActions: vi.fn(
    async (_args: {
      orgId: string;
      entries: Array<Record<string, unknown>>;
      label: string;
    }): Promise<unknown> => ({ billedUnits: 1 }),
  ),
}));
vi.mock("@oxagen/billing", async () => {
  // The ledger module alone, not the package: the package's index builds
  // statement queries from `schema` at load time, and this file's database
  // double carries only the MCP tables. Typed through the package name, since
  // a type import of the path would pull another package's source under this
  // one's `rootDir`.
  const ledger = await vi.importActual<
    Pick<
      typeof import("@oxagen/billing"),
      "attributableWorkspaceId" | "governedActionEntry" | "ledgerKey"
    >
  >("../../../billing/src/gau-ledger");
  return {
    attributableWorkspaceId: ledger.attributableWorkspaceId,
    governedActionEntry: ledger.governedActionEntry,
    ledgerKey: ledger.ledgerKey,
    assertGauAvailable: billingMocks.assertGauAvailable,
    recordGovernedActions: billingMocks.recordGovernedActions,
  };
});

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
  createApprovalRequest: vi.fn(async () => ({
    approvalId: "appr_x",
    publicId: "apr_x",
  })),
  waitForApproval: vi.fn(
    async (): Promise<{
      approvalId: string;
      resolution: "approved" | "denied" | "expired";
      note: null;
    }> => ({ approvalId: "appr_x", resolution: "approved", note: null }),
  ),
  insertToolInvocation: vi.fn(async () => undefined),
}));

vi.mock("./approval", () => ({
  createApprovalRequest: mocks.createApprovalRequest,
  waitForApproval: mocks.waitForApproval,
}));

// Consent gate. checkConsent/recordConsent are spied so we can drive
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
// agent-principal rows without a ClickHouse client. The listing's read of the
// active emergency denies is a spy too (the DB stub above has no
// emergency_denies table); the matcher the belt decision applies to those
// rows stays real, so a kill-switch scenario exercises the same predicate the
// kernel runs at invoke.
const iamMocks = vi.hoisted(() => ({
  emitAudit: vi.fn(async () => undefined),
  readActiveEmergencyDenies: vi.fn(
    async (): Promise<
      readonly import("@oxagen/iam").ActiveEmergencyDeny[]
    > => [],
  ),
}));
vi.mock("@oxagen/iam", async () => {
  const live = await vi.importActual<
    typeof import("@oxagen/iam/live-agent-run-authorization")
  >("@oxagen/iam/live-agent-run-authorization");
  const scopes = await vi.importActual<
    typeof import("@oxagen/iam/resource-scope")
  >("@oxagen/iam/resource-scope");
  return {
    emitAudit: iamMocks.emitAudit,
    matchEmergencyDeny: live.matchEmergencyDeny,
    readActiveEmergencyDenies: iamMocks.readActiveEmergencyDenies,
    resourceScopeDigestOf: scopes.resourceScopeDigestOf,
  };
});

import {
  materializeTools,
  digestInputFor,
  type MaterializeOptions,
} from "./materialize-tools";
import { decideCapabilityForBelt } from "./toolbelt";
import { resourceScopeDigestOf, type ActiveEmergencyDeny } from "@oxagen/iam";
import type { RegistryCapability } from "../registry-loader";
import {
  invoke,
  authorizeExternalCapability,
  emitExternalCapabilityOutcome,
} from "@oxagen/oxagen/kernel";
import {
  createAgentRunResolution,
  resolveAgentRunCapability,
  type AgentAuthzSnapshot,
  type AgentRunIAMContext,
  type AgentRunIAMResolution,
} from "@oxagen/oxagen/iam";
import { connectMcp, listMcpToolDescriptors } from "../dispatch/mcp-client";
import { listEntitledCapabilityPluginIds } from "@oxagen/plugins";
import { pluginForContract } from "@oxagen/oxagen/plugins";
import {
  EXTERNAL_TOOL_SEGMENT_MAX,
  isAdmissibleToolIdentity,
} from "@oxagen/run-ledger";
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
    vi.mocked(emitExternalCapabilityOutcome).mockClear();
    vi.mocked(authorizeExternalCapability).mockResolvedValue({
      allowed: true,
      outcome: "allow",
      reason: null,
      decision: null,
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
      runId: null,
    });
  });

  it("hands the model's tool-call id to the kernel so a retried call bills once (ADR-165)", async () => {
    const { tools } = await materializeTools(CTX);
    const t = tools.capA as unknown as {
      execute: (
        i: unknown,
        options?: { toolCallId?: string },
      ) => Promise<unknown>;
    };
    await t.execute({ x: "hello" }, { toolCallId: "call_cap" });
    expect(invoke).toHaveBeenCalledWith(
      "capA",
      { x: "hello" },
      { ...CTX, toolCallId: "call_cap" },
      { surface: "agent", runId: null },
    );
    // No id, or an empty one: the context goes through as it came, the same
    // object, so nothing downstream sees a field the caller never set.
    await t.execute({ x: "again" });
    await t.execute({ x: "empty" }, { toolCallId: "" });
    expect(vi.mocked(invoke).mock.calls[1]?.[2]).toBe(CTX);
    expect(vi.mocked(invoke).mock.calls[2]?.[2]).toBe(CTX);
  });

  it("a successful invocation resolves cleanly through the kernel", async () => {
    const { tools } = await materializeTools(CTX);
    await expect(
      (
        tools.capA as unknown as { execute: (i: unknown) => Promise<unknown> }
      ).execute({ x: "hi" }),
    ).resolves.toBeDefined();
  });

  it("rethrows a handler failure to the caller (tool_invocations records it)", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("boom"));
    const { tools } = await materializeTools(CTX);
    await expect(
      (
        tools.capA as unknown as { execute: (i: unknown) => Promise<unknown> }
      ).execute({ x: "hi" }),
    ).rejects.toThrow("boom");
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

  it("digests the validated input, not the raw tool arguments, so the standing window can match the invocation", async () => {
    // capB's schema is widened here with a default and a coercion. The tool is
    // called without the defaulted key and with the coerced one as a string,
    // which is what an AI SDK tool call looks like. invoke() digests
    // cap.input.safeParse(raw).data, so the approval row has to store that same
    // parsed value or the window keys on something the invocation never asks
    // for.
    mocks.createApprovalRequest.mockClear();
    mocks.waitForApproval.mockClear();
    const fixtureGated = [
      {
        ...FIXTURE[2],
        agent: { riskLevel: "high" as const, requiresApproval: true },
        input: z.object({
          y: z.coerce.number(),
          mode: z.string().default("safe"),
        }),
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
    const { tools } = await mt({ ...CTX, messageId: "msg_43" });
    await (
      tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ y: "1" });

    const call = mocks.createApprovalRequest.mock.calls.at(0)?.at(0) as
      | { digestInput: unknown; inputPreview: unknown }
      | undefined;
    expect(call).toBeDefined();
    expect(call?.digestInput).toEqual({ y: 1, mode: "safe" });
    // The preview stays raw on purpose: it is what the person is shown, and
    // showing them a value the model did not send would misreport the request.
    expect(call?.inputPreview).toEqual({ y: "1" });
  });

  it("parks the call under approvalMode park: the request is created, the event fires, nothing waits and the handler never runs", async () => {
    mocks.createApprovalRequest.mockClear();
    mocks.waitForApproval.mockClear();
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
    const { materializeTools: mt, ApprovalPendingError } = await import(
      "./materialize-tools"
    );
    const events: unknown[] = [];
    const { tools } = await mt(
      { ...CTX, messageId: "msg_42" },
      { approvalMode: "park", onApprovalRequired: (e) => events.push(e) },
    );
    await expect(
      (
        tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }
      ).execute({ y: 1 }),
    ).rejects.toSatisfy(
      (e) =>
        e instanceof ApprovalPendingError &&
        e.code === "pending_approval" &&
        e.capability === FIXTURE[2]!.name,
    );
    expect(mocks.createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(mocks.waitForApproval).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    // The row uuid keys waiters; the public id is what the parked card shows
    // and what the list reads answer.
    expect(events[0]).toMatchObject({
      approvalId: "appr_x",
      approvalPublicId: "apr_x",
    });
  });

  it("attaches a parked approval to the run set on runIdRef AFTER materialization, not the run captured at materialize time (finding 9, negative)", async () => {
    // The in-app assistant materializes tools before `openAssistantRun` opens
    // the run (the belt has to exist first, to build the run's own
    // `toolAllowlist`), so `ctx.agentRun` is unset when these closures are
    // built. `runIdRef` is how the run, once opened, reaches a call that
    // executes later — every `execute` closure reads `runIdRef.current` at
    // call time, not a value captured when materializeTools ran.
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
    const runIdRef: { current: string | null } = { current: null };
    const { tools } = await mt({ ...CTX, messageId: "msg_42" }, { runIdRef });
    // The run opens only after materializeTools has already returned —
    // exactly the order `runPreparedTurn` follows. The value is the internal
    // UUID `createApprovalRequest` → `resolveRunPublicId` accepts.
    runIdRef.current = "0192d4a8-7c1e-7a00-8000-0000000000a1";
    await (
      tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ y: 1 });
    const call = mocks.createApprovalRequest.mock.calls.at(0)?.at(0) as
      | { runId: string | null }
      | undefined;
    expect(call?.runId).toBe("0192d4a8-7c1e-7a00-8000-0000000000a1");
  });

  it("falls back to ctx.agentRun.runId when the caller passes no runIdRef (negative)", async () => {
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
    const { tools } = await mt({ ...CTX, messageId: "msg_44" });
    await (
      tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ y: 1 });
    const call = mocks.createApprovalRequest.mock.calls.at(0)?.at(0) as
      | { runId: string | null }
      | undefined;
    // CTX (no agentRun, no runIdRef) carries neither, so the call is not
    // attached to a run rather than to a wrong one.
    expect(call?.runId).toBeNull();
  });

  it("threads runIdRef.current into invoke()'s opts.runId for a capability with no approval gate, so an auto-approval receipt (#3153) attaches to the run the assistant opened after materializing tools", async () => {
    const runIdRef: { current: string | null } = { current: null };
    const { tools } = await materializeTools(
      { ...CTX, messageId: "msg_45" },
      { runIdRef },
    );
    // Same ordering as the approval-gated case above: the run opens only
    // after materializeTools has already returned.
    runIdRef.current = "arun_live_45";
    const capATool = tools.capA as unknown as {
      execute: (i: unknown) => Promise<unknown>;
    };
    await capATool.execute({ x: "hello" });
    expect(invoke).toHaveBeenCalledWith(
      "capA",
      { x: "hello" },
      { ...CTX, messageId: "msg_45" },
      { surface: "agent", runId: "arun_live_45" },
    );
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
      { surface: "agent", runId: null },
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
      { surface: "agent", runId: null },
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
      return { approvalId: "appr_scoped", publicId: "apr_scoped" };
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
      publicId: "apr_x",
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
  const fakeExecute = vi.fn(
    async (): Promise<{ isError?: boolean; content: { data: string } }> => ({
      content: { data: "result" },
    }),
  );

  beforeEach(() => {
    vi.mocked(authorizeExternalCapability).mockClear();
    vi.mocked(emitExternalCapabilityOutcome).mockClear();
    vi.mocked(authorizeExternalCapability).mockResolvedValue({
      allowed: true,
      outcome: "allow",
      reason: null,
      decision: null,
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
      { audit: false },
    );
    // Repeated preflights produce one final invocation event.
    expect(fakeExecute).toHaveBeenCalledTimes(1);
    expect(authorizeExternalCapability).toHaveBeenCalledTimes(2);
    expect(externalRulesMock).toHaveBeenCalledTimes(3);
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledOnce();
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledWith(
      `mcp.${MCP_SERVER.id}.list_pull_requests`,
      CTX,
      "allow",
      expect.any(Number),
      undefined,
    );
  });

  it("audits a resolved MCP error result as one failed invocation", async () => {
    fakeExecute.mockResolvedValueOnce({
      isError: true,
      content: { data: "refused" },
    });
    const { tools } = await materializeTools(CTX);
    const t = tools[`mcp_${MCP_SERVER.id}_list_pull_requests`] as unknown as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await expect(t.execute({})).rejects.toMatchObject({
      code: "mcp_tool_execution_failed",
    });
    expect(fakeExecute).toHaveBeenCalledOnce();
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledOnce();
    // The audit cause is the code alone: the remote tool's error payload
    // stays out of the audit row.
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledWith(
      `mcp.${MCP_SERVER.id}.list_pull_requests`,
      CTX,
      "error",
      expect.any(Number),
      { code: "mcp_tool_execution_failed" },
    );
    expect(mocks.insertToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error_class: "McpToolExecutionError",
      }),
    );
  });

  it.each([1, 2, 3])(
    "blocks the transport when external rules refuse at check %i",
    async (checkNumber) => {
      for (let i = 1; i < checkNumber; i++)
        externalRulesMock.mockResolvedValueOnce(undefined);
      externalRulesMock.mockRejectedValueOnce(
        new Error("external decision denied"),
      );
      const { tools } = await materializeTools(CTX);
      const t = tools[`mcp_${MCP_SERVER.id}_list_pull_requests`] as unknown as {
        execute: (input: unknown) => Promise<unknown>;
      };
      await expect(t.execute({})).rejects.toThrow("external decision denied");
      expect(fakeExecute).not.toHaveBeenCalled();
      expect(externalRulesMock).toHaveBeenCalledTimes(checkNumber);
      expect(emitExternalCapabilityOutcome).toHaveBeenCalledOnce();
      expect(emitExternalCapabilityOutcome).toHaveBeenCalledWith(
        `mcp.${MCP_SERVER.id}.list_pull_requests`,
        CTX,
        "error",
        expect.any(Number),
        expect.objectContaining({ message: "external decision denied" }),
      );
      expect(mocks.insertToolInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", error_class: "Error" }),
      );
    },
  );

  it("parks external decision approvals without dispatching transport", async () => {
    const onApprovalRequired = vi.fn();
    externalRulesMock.mockImplementationOnce(() => {
      const args = externalRulesFactory.mock.calls[0]?.[0] as {
        onApprovalRequired: (event: {
          approvalId: string;
          capability: string;
          inputPreview: unknown;
          riskLevel: "high";
          expiresAt: string;
        }) => void;
      };
      args.onApprovalRequired({
        approvalId: "parked-external",
        capability: "external",
        inputPreview: {},
        riskLevel: "high",
        expiresAt: "2099-01-01T00:00:00Z",
      });
    });
    const { tools } = await materializeTools(CTX, {
      approvalMode: "park",
      onApprovalRequired,
    });
    const t = tools[`mcp_${MCP_SERVER.id}_list_pull_requests`] as unknown as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await expect(t.execute({})).rejects.toMatchObject({
      code: "pending_approval",
      approvalId: "parked-external",
    });
    expect(onApprovalRequired).toHaveBeenCalledOnce();
    expect(fakeExecute).not.toHaveBeenCalled();
    expect(emitExternalCapabilityOutcome).not.toHaveBeenCalled();
  });

  it("refuses IAM revoked during an external approval or consent wait", async () => {
    vi.mocked(authorizeExternalCapability)
      .mockResolvedValueOnce({
        allowed: true,
        outcome: "allow",
        reason: null,
        decision: null,
      })
      .mockResolvedValueOnce({
        allowed: false,
        outcome: "deny",
        reason: "revoked_during_wait",
        decision: null,
      });
    const { tools } = await materializeTools(CTX);
    const t = tools[`mcp_${MCP_SERVER.id}_list_pull_requests`] as unknown as {
      execute: (input: unknown) => Promise<unknown>;
    };
    expect(await t.execute({})).toContain("revoked_during_wait");
    expect(fakeExecute).not.toHaveBeenCalled();
    expect(authorizeExternalCapability).toHaveBeenCalledTimes(2);
    expect(mocks.insertToolInvocation).toHaveBeenCalledOnce();
    expect(mocks.insertToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error_class: "IamDenied" }),
    );
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledOnce();
    // The re-check after the wait is a policy deny like the first, and the
    // one audit row carries that code rather than nothing.
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledWith(
      `mcp.${MCP_SERVER.id}.list_pull_requests`,
      CTX,
      "deny",
      expect.any(Number),
      expect.objectContaining({ code: "authz_denied" }),
    );
  });

  it("records one transport failure when the external transport throws", async () => {
    const error = new Error(
      "transport failed: https://user:secret@mcp.example",
    );
    fakeExecute.mockRejectedValueOnce(error);
    const { tools } = await materializeTools(CTX);
    const t = tools[`mcp_${MCP_SERVER.id}_list_pull_requests`] as unknown as {
      execute: (input: unknown) => Promise<unknown>;
    };
    await expect(t.execute({})).rejects.toBe(error);
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledOnce();
    // A transport failure is not a refusal, and the audit cause carries no
    // part of the error message, which can hold a credential.
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledWith(
      `mcp.${MCP_SERVER.id}.list_pull_requests`,
      CTX,
      "error",
      expect.any(Number),
      { code: "mcp_transport_failed" },
    );
  });

  describe("governed action billing (ADR-165)", () => {
    const KEY = `mcp.${MCP_SERVER.id}.list_pull_requests`;
    const RUN_CTX = { ...CTX, runId: "run_1" };
    type Execute = (
      input: unknown,
      options?: { toolCallId?: string },
    ) => Promise<unknown>;
    const external = async (ctx: typeof CTX = RUN_CTX): Promise<Execute> => {
      const { tools } = await materializeTools(ctx);
      return (
        tools[`mcp_${MCP_SERVER.id}_list_pull_requests`] as unknown as {
          execute: Execute;
        }
      ).execute;
    };
    const offered = () =>
      billingMocks.recordGovernedActions.mock.calls.map(
        ([args]) => args.entries,
      );

    beforeEach(() => {
      billingMocks.scopes.length = 0;
      billingMocks.assertGauAvailable
        .mockReset()
        .mockImplementation(async () => {
          billingMocks.scopes.push(tenancyMock.state.current);
        });
      billingMocks.recordGovernedActions
        .mockReset()
        .mockImplementation(async () => {
          billingMocks.scopes.push(tenancyMock.state.current);
          return { billedUnits: 1 };
        });
    });

    it("bills one unit for a completed call, keyed by the model's tool-call id within the run", async () => {
      const execute = await external();
      await expect(execute({}, { toolCallId: "call_1" })).resolves.toEqual({
        data: "result",
      });
      expect(billingMocks.assertGauAvailable).toHaveBeenCalledWith("ten_1");
      expect(billingMocks.recordGovernedActions).toHaveBeenCalledOnce();
      expect(
        billingMocks.recordGovernedActions.mock.calls[0]?.[0],
      ).toMatchObject({ orgId: "ten_1", label: KEY });
      expect(offered()).toEqual([
        [
          expect.objectContaining({
            idempotencyKey: "external_tool:run_1:call_1",
            source: "external_tool",
            units: 1,
            toolName: KEY,
            mcpServer: "GitHub",
            surface: "agent",
            runId: "run_1",
            toolCallId: "call_1",
            operatorUserId: "u_1",
            agentId: null,
            requestId: "req_1",
            // `ws_1` is not a uuid, so it is not a workspace to attribute to.
            workspaceId: null,
          }),
        ],
      ]);
      // Both the gate and the recorder ran inside the org's tenant scope.
      expect(billingMocks.scopes).toEqual([
        { orgId: "ten_1", workspaceId: "ws_1" },
        { orgId: "ten_1", workspaceId: "ws_1" },
      ]);
    });

    it("offers a retried call the same key, so the ledger bills it once", async () => {
      const execute = await external();
      await execute({}, { toolCallId: "call_1" });
      await execute({}, { toolCallId: "call_1" });
      const keys = offered().map((entries) => entries[0]?.["idempotencyKey"]);
      expect(keys).toEqual([
        "external_tool:run_1:call_1",
        "external_tool:run_1:call_1",
      ]);
    });

    it("gives a call with no tool-call id a key of its own, so two calls bill twice", async () => {
      const execute = await external();
      await execute({});
      await execute({});
      const keys = offered().map((entries) => entries[0]?.["idempotencyKey"]);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
      for (const key of keys)
        expect(key).toMatch(/^external_tool:run_1:inv:[0-9a-f-]{36}$/);
    });

    it("does not scope a tool-call id to nothing: outside a run or turn the key is the invocation's", async () => {
      const execute = await external(CTX);
      await execute({}, { toolCallId: "call_1" });
      expect(offered()[0]?.[0]).toMatchObject({
        idempotencyKey: expect.stringMatching(/^external_tool:-:inv:/),
        toolCallId: "call_1",
        runId: null,
      });
    });

    it("attributes an agent run's call to the agent and the person who started it", async () => {
      const execute = await external({
        ...RUN_CTX,
        // Only the fields the recorder reads. The run's IAM gates are
        // mocked in this suite, so no resolution is consulted.
        agentRun: undefined,
        deployedAgentInvocation: {
          agentId: "agt_1",
          initiatingPrincipal: { id: "prn_human" },
        },
      } as unknown as typeof CTX);
      vi.mocked(authorizeExternalCapability).mockResolvedValue({
        allowed: true,
        outcome: "allow",
        reason: null,
        decision: null,
        principal: { id: "prn_agent", kind: "agent" },
      } as Awaited<ReturnType<typeof authorizeExternalCapability>>);
      await execute({}, { toolCallId: "call_2" });
      expect(offered()[0]?.[0]).toMatchObject({
        agentId: "agt_1",
        operatorUserId: "prn_human",
        principalId: "prn_agent",
        principalKind: "agent",
      });
    });

    it("bills nothing for a call IAM refuses, the transport fails, or the server answers with an error", async () => {
      vi.mocked(authorizeExternalCapability).mockResolvedValueOnce({
        allowed: false,
        outcome: "deny",
        reason: "denied",
        decision: null,
      });
      const execute = await external();
      expect(await execute({}, { toolCallId: "a" })).toContain("denied");
      fakeExecute.mockRejectedValueOnce(new Error("transport failed"));
      await expect(execute({}, { toolCallId: "b" })).rejects.toThrow(
        "transport failed",
      );
      fakeExecute.mockResolvedValueOnce({
        isError: true,
        content: { data: "refused" },
      });
      await expect(execute({}, { toolCallId: "c" })).rejects.toMatchObject({
        code: "mcp_tool_execution_failed",
      });
      expect(billingMocks.recordGovernedActions).not.toHaveBeenCalled();
    });

    it("refuses the call when the organisation has no units left, before any gate asks a person", async () => {
      const exhausted = Object.assign(
        new Error("Governed action units exhausted: the bucket is empty."),
        { name: "GauExhaustedError", code: "gau_exhausted" },
      );
      billingMocks.assertGauAvailable.mockRejectedValueOnce(exhausted);
      const execute = await external();
      await expect(execute({}, { toolCallId: "call_1" })).rejects.toBe(
        exhausted,
      );
      expect(fakeExecute).not.toHaveBeenCalled();
      expect(externalRulesMock).not.toHaveBeenCalled();
      expect(billingMocks.recordGovernedActions).not.toHaveBeenCalled();
      expect(mocks.insertToolInvocation).toHaveBeenCalledOnce();
      expect(mocks.insertToolInvocation).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          error_class: "GauExhaustedError",
        }),
      );
      expect(emitExternalCapabilityOutcome).toHaveBeenCalledWith(
        KEY,
        RUN_CTX,
        "error",
        expect.any(Number),
        exhausted,
      );
    });

    it("returns a completed call's result when recording its unit fails", async () => {
      billingMocks.recordGovernedActions.mockRejectedValueOnce(
        new Error("ledger unavailable"),
      );
      const execute = await external();
      await expect(execute({}, { toolCallId: "call_1" })).resolves.toEqual({
        data: "result",
      });
      expect(fakeExecute).toHaveBeenCalledOnce();
      expect(emitExternalCapabilityOutcome).toHaveBeenCalledWith(
        KEY,
        RUN_CTX,
        "allow",
        expect.any(Number),
        undefined,
      );
    });
  });

  it("keeps final IAM denial fail-closed when telemetry insertion fails", async () => {
    vi.mocked(authorizeExternalCapability)
      .mockResolvedValueOnce({
        allowed: true,
        outcome: "allow",
        reason: null,
        decision: null,
      })
      .mockResolvedValueOnce({
        allowed: false,
        outcome: "deny",
        reason: "revoked",
        decision: null,
      });
    mocks.insertToolInvocation.mockRejectedValueOnce(
      new Error("telemetry unavailable"),
    );
    const { tools } = await materializeTools(CTX);
    const t = tools[`mcp_${MCP_SERVER.id}_list_pull_requests`] as unknown as {
      execute: (input: unknown) => Promise<unknown>;
    };
    expect(await t.execute({})).toContain("revoked");
    expect(fakeExecute).not.toHaveBeenCalled();
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledTimes(1);
  });

  it("runs the IAM gate inside the turn's tenant scope (regression: fetchAuthz needs withTenantDb)", async () => {
    let scopeAtIam: unknown = "UNSET";
    vi.mocked(authorizeExternalCapability).mockImplementationOnce(async () => {
      scopeAtIam = tenancyMock.state.current;
      return { allowed: true, outcome: "allow", reason: null, decision: null };
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
      decision: null,
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
    // The one audit row names the policy deny, not a generic refusal.
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledOnce();
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledWith(
      `mcp.${MCP_SERVER.id}.list_pull_requests`,
      CTX,
      "deny",
      expect.any(Number),
      expect.objectContaining({ code: "authz_denied" }),
    );
  });

  it.each([
    ["iam_check_error", "authz_check_error"],
    ["decision_not_persisted", "authz_decision_not_persisted"],
  ])(
    "audits the kernel's own %s denial under %s, apart from a policy deny",
    async (reason, code) => {
      vi.mocked(authorizeExternalCapability).mockResolvedValueOnce({
        allowed: false,
        outcome: "deny",
        reason,
        decision: null,
      });
      const { tools } = await materializeTools(CTX);
      const t = tools[`mcp_${MCP_SERVER.id}_list_pull_requests`] as {
        execute?: (i: unknown) => Promise<unknown>;
      };
      const result = await t.execute!({});
      expect(fakeExecute).not.toHaveBeenCalled();
      expect(result as string).toContain(reason);
      expect(emitExternalCapabilityOutcome).toHaveBeenCalledWith(
        `mcp.${MCP_SERVER.id}.list_pull_requests`,
        CTX,
        "deny",
        expect.any(Number),
        expect.objectContaining({ code }),
      );
    },
  );

  it("meters a denied invocation as status=denied in insertToolInvocation (GAP-4 + instrument-everything)", async () => {
    vi.mocked(authorizeExternalCapability).mockResolvedValueOnce({
      allowed: false,
      outcome: "deny",
      reason: "explicit_deny",
      decision: null,
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
      killSwitches: expect.objectContaining({ check: expect.any(Function) }),
    });
  });

  it("drops an external tool whose governed identity a run spec cannot carry, and keeps its siblings", async () => {
    // A contributor's names are a third party's: an MCP server's `tools/list`
    // or a `.oxagen/settings.json` server key. `openAssistantRun` pins EVERY
    // materialized tool into `tool_policy.allowlist`, so one identity the
    // spec refuses does not fail that tool — it fails admission, and with it
    // every assistant turn in the workspace, including turns that would never
    // have called it. One tool missing from the belt is the cheap failure.
    const serverId = "0192d4a8-7c1e-7a00-8000-0000000000aa";
    const ok = `mcp.${serverId}.list_pull_requests`;
    const overLong = `mcp.${serverId}.${"z".repeat(EXTERNAL_TOOL_SEGMENT_MAX + 1)}`;
    // The premise, not assumed: the short one is carryable and the long one
    // is not. Without this the test would pass on both being dropped.
    expect(isAdmissibleToolIdentity(ok)).toBe(true);
    expect(isAdmissibleToolIdentity(overLong)).toBe(false);

    const raw = (realName: string, toolName: string) => ({
      realName,
      description: "d",
      execute: async () => "ok",
      externalServerId: serverId,
      externalServerName: "GitHub",
      externalToolName: toolName,
    });
    vi.doMock("./plugin-type", async (importOriginal) => {
      const real = await importOriginal<typeof import("./plugin-type")>();
      return {
        ...real,
        getPluginTypeContributors: vi.fn(() => [
          {
            type: "mcp_server" as const,
            contributeTools: vi.fn(async () => [
              raw(ok, "list_pull_requests"),
              raw(overLong, "z".repeat(EXTERNAL_TOOL_SEGMENT_MAX + 1)),
            ]),
          },
        ]),
      };
    });
    vi.resetModules();
    const { materializeTools: mt } = await import("./materialize-tools");

    const { nameMap } = await mt(CTX, {});
    const canonical = Object.values(nameMap);

    expect(canonical).toContain(ok);
    expect(canonical).not.toContain(overLong);
    // Dropped, never truncated: a truncated identity is a different tool as
    // far as governance is concerned, and two long names could collide on one.
    expect(canonical.some((c) => c.startsWith(`mcp.${serverId}.z`))).toBe(
      false,
    );
  });
});

// ── First-use consent gate ─────────────────────────────────────────
// These tests verify the external-MCP consent gate runs AFTER the IAM gate and
// BEFORE the transport: a first-use call (no grant) solicits consent + blocks;
// a denied grant short-circuits; a pre-existing grant runs inline.
describe("materializeTools — kill switches (spec §6.11)", () => {
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
  const fakeExecute = vi.fn(async () => ({ content: { data: "result" } }));
  const hit = {
    id: "id_1",
    publicId: "emd_1",
    targetKind: "class" as const,
    targetId: "moves_money",
    scopeKind: "org" as const,
    workspaceId: null,
    capabilityId: null,
    resourceScopeDigest: "sha256:" + "0".repeat(64),
    principalId: null,
    reason: "processor incident",
    active: true,
    activatedAt: new Date("2026-09-15T00:00:00Z"),
    deactivatedAt: null,
    flippedByUserId: "u_2",
    updatedById: "u_2",
  };

  beforeEach(() => {
    killSwitchMocks.check.mockReset().mockResolvedValue(null);
    vi.mocked(invoke).mockClear();
    vi.mocked(authorizeExternalCapability).mockClear();
    vi.mocked(emitExternalCapabilityOutcome).mockClear();
    fakeExecute.mockClear();
    mocks.insertToolInvocation.mockClear();
    mocks.insertToolInvocation.mockResolvedValue(undefined);
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

  // The gate is asked at materialization too (the contributor asks about
  // each server), so a switched call is keyed by its facts; the open gate is
  // restored for the describes that follow.
  afterEach(() => {
    killSwitchMocks.check.mockReset().mockResolvedValue(null);
  });

  it("asks the gate before every capability call with the call's facts", async () => {
    const { tools } = await materializeTools(CTX);
    await (
      tools.capA as unknown as { execute: (i: unknown) => Promise<unknown> }
    ).execute({ x: "hi" });
    expect(killSwitchMocks.check).toHaveBeenCalledWith({
      capabilityId: "capA",
      readOnly: expect.any(Boolean),
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("a switched capability never reaches the kernel and fails with the switch's reason", async () => {
    killSwitchMocks.check.mockImplementation(async (facts) =>
      facts.capabilityId === "capA" ? hit : null,
    );
    const { tools } = await materializeTools(CTX);
    await expect(
      (
        tools.capA as unknown as { execute: (i: unknown) => Promise<unknown> }
      ).execute({ x: "hi" }),
    ).rejects.toThrow(/kill switch \(class moves_money\): processor incident/);
    expect(invoke).not.toHaveBeenCalled();
    const call = (
      mocks.insertToolInvocation.mock.calls[0] as unknown as [unknown]
    )?.[0] as Record<string, unknown>;
    expect(call.status).toBe("failed");
    expect(call.error_class).toBe("KillSwitchDeniedError");
  });

  it("asks the gate for an external tool with its server and connection, before IAM and the transport", async () => {
    const capabilityId = `mcp.${MCP_SERVER.id}.list_pull_requests`;
    killSwitchMocks.check.mockImplementation(async (facts) =>
      facts.capabilityId === capabilityId ? hit : null,
    );
    const { tools } = await materializeTools(CTX);
    // The contributor asked the same gate about the server when the turn was
    // materialized, before the server was reached.
    expect(killSwitchMocks.check).toHaveBeenCalledWith({
      capabilityId: `mcp.${MCP_SERVER.id}`,
      serverId: MCP_SERVER.id,
      connectionId: null,
      readOnly: false,
    });
    const t = tools[`mcp_${MCP_SERVER.id}_list_pull_requests`] as unknown as {
      execute?: (i: unknown) => Promise<unknown>;
    };
    const result = await t.execute!({});
    expect(killSwitchMocks.check).toHaveBeenCalledWith({
      capabilityId: `mcp.${MCP_SERVER.id}.list_pull_requests`,
      serverId: MCP_SERVER.id,
      connectionId: null,
      readOnly: false,
    });
    expect(authorizeExternalCapability).not.toHaveBeenCalled();
    expect(fakeExecute).not.toHaveBeenCalled();
    expect(result).toMatch(/blocked by kill switch/);
    const call = (
      mocks.insertToolInvocation.mock.calls[0] as unknown as [unknown]
    )?.[0] as Record<string, unknown>;
    expect(call.status).toBe("failed");
    expect(call.error_class).toBe("KillSwitchDeniedError");
    // A thrown switch is not a policy deny, and the audit row says which.
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledOnce();
    expect(emitExternalCapabilityOutcome).toHaveBeenCalledWith(
      capabilityId,
      CTX,
      "deny",
      expect.any(Number),
      expect.objectContaining({ code: "kill_switch_denied" }),
    );
  });

  /** A gate that finds `capabilityId` open on its first call and switched from the second on. */
  const switchedDuringWait = (capabilityId: string) => {
    let calls = 0;
    killSwitchMocks.check.mockImplementation(async (facts) =>
      facts.capabilityId === capabilityId && ++calls > 1 ? hit : null,
    );
    return () => calls;
  };

  it("a switch flipped while an approval card is open stops the capability once approved", async () => {
    const callsFor = switchedDuringWait("capB");
    mocks.createApprovalRequest.mockClear();
    mocks.waitForApproval.mockClear();
    mocks.waitForApproval.mockResolvedValueOnce({
      approvalId: "appr_x",
      resolution: "approved",
      note: null,
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
    const kernel = await import("@oxagen/oxagen/kernel");
    vi.mocked(kernel.invoke).mockClear();
    const { tools } = await mt({ ...CTX, messageId: "msg_42" });
    await expect(
      (
        tools.capB as unknown as { execute: (i: unknown) => Promise<unknown> }
      ).execute({ y: 1 }),
    ).rejects.toThrow(/kill switch \(class moves_money\)/);
    expect(mocks.waitForApproval).toHaveBeenCalledTimes(1);
    expect(callsFor()).toBe(2);
    expect(kernel.invoke).not.toHaveBeenCalled();
    vi.doUnmock("@oxagen/oxagen");
  });

  it("a switch flipped while a consent card is open stops the external tool once consent is granted", async () => {
    const capabilityId = `mcp.${MCP_SERVER.id}.list_pull_requests`;
    const callsFor = switchedDuringWait(capabilityId);
    consentMocks.checkConsent.mockClear();
    consentMocks.checkConsent.mockResolvedValue(null);
    mocks.createApprovalRequest.mockClear();
    mocks.waitForApproval.mockClear();
    mocks.waitForApproval.mockResolvedValueOnce({
      approvalId: "appr_x",
      resolution: "approved",
      note: null,
    });
    const { tools } = await materializeTools({
      ...CTX,
      messageId: "msg_42",
      userId: "u_1",
    });
    const t = tools[`mcp_${MCP_SERVER.id}_list_pull_requests`] as unknown as {
      execute?: (i: unknown) => Promise<unknown>;
    };
    const result = await t.execute!({});
    expect(mocks.waitForApproval).toHaveBeenCalledTimes(1);
    expect(callsFor()).toBe(2);
    expect(fakeExecute).not.toHaveBeenCalled();
    expect(result).toMatch(/blocked by kill switch/);
    const failed = mocks.insertToolInvocation.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0],
    );
    expect(failed.map((r) => r.error_class)).toEqual(["KillSwitchDeniedError"]);
  });
});

describe("materializeTools — first-use consent gate", () => {
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
    vi.mocked(emitExternalCapabilityOutcome).mockClear();
    vi.mocked(authorizeExternalCapability).mockResolvedValue({
      allowed: true,
      outcome: "allow",
      reason: null,
      decision: null,
    });
    fakeExecute.mockClear();
    mocks.insertToolInvocation.mockClear();
    mocks.insertToolInvocation.mockResolvedValue(undefined);
    mocks.createApprovalRequest.mockClear();
    mocks.createApprovalRequest.mockResolvedValue({
      approvalId: "appr_consent",
      publicId: "apr_consent",
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

  it("the consent card carries the risk level the engine is told", async () => {
    const { tools, governance } = await materializeTools(CHAT_CTX);
    const alias = `mcp_${MCP_SERVER.id}_list_pull_requests`;
    await (tools[alias] as { execute?: (i: unknown) => Promise<unknown> })
      .execute!({});
    expect(governance[alias]?.riskLevel).toBe("high");
    expect(mocks.createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityName: `mcp.${MCP_SERVER.id}.list_pull_requests`,
        riskLevel: governance[alias]?.riskLevel,
      }),
    );
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
    // A person saying no is audited as consent, not as a policy deny.
    expect(emitExternalCapabilityOutcome).toHaveBeenLastCalledWith(
      `mcp.${MCP_SERVER.id}.list_pull_requests`,
      CHAT_CTX,
      "deny",
      expect.any(Number),
      expect.objectContaining({ code: "consent_denied" }),
    );
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

// The tool-LIST filter (UX layer) a surface uses to narrow the advertised set
// below the run's allowlist. The kernel gate stays the enforcement boundary.
describe("materializeTools — excludeCapabilities", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("withholds capabilities named in excludeCapabilities", async () => {
    const { tools, nameMap } = await materializeTools(CTX, {
      excludeCapabilities: new Set(["fill_form"]),
    });
    expect(tools["fill_form"]).toBeUndefined();
    expect(Object.values(nameMap)).not.toContain("fill_form");
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
    iamMocks.readActiveEmergencyDenies.mockResolvedValue([]);
    // The plugin-entitlement suite above leaves its last claim and
    // entitlement set on the mocks; both sides of the parity test below read
    // the same two seams, so they are pinned to the builtin baseline here.
    vi.mocked(pluginForContract).mockReturnValue(undefined);
    vi.mocked(listEntitledCapabilityPluginIds).mockResolvedValue(
      new Set<string>(),
    );
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

  // Toolbelt parity (#2956, ADR-057): `get_agent_toolbelt` reports the belt
  // by calling `decideCapabilityForBelt` over the registry; the runtime's
  // listing must be exactly the tools that function does not deny, on every
  // gate the runtime applies — surface, exclusion, allowlist, risk ceiling,
  // the cached delegation ceiling and its fail-closed branch, and the active
  // emergency denies.
  type ParityScenario = {
    agentRun: null | "observer" | "contributor" | "unresolved";
    opts: Pick<
      MaterializeOptions,
      "allowlist" | "excludeCapabilities" | "riskCeiling" | "actingAgent"
    >;
    /** What `readActiveEmergencyDenies` answers; both sides see the rows. */
    emergencyDenies?: ActiveEmergencyDeny[];
  };
  const killSwitch = (
    capabilityId: string,
    principalId: string | null = null,
  ): ActiveEmergencyDeny => ({
    publicId: `edn_${capabilityId}`,
    denyKind: "capability",
    capabilityId,
    resourceScopeDigest: null,
    principalId,
    reason: "incident",
  });
  /** The workspace's assistant agent, as its turn passes it. */
  const ASSISTANT = { agentId: "agt_assistant", principalId: "prn_assistant" };
  /** An `agent` switch on the assistant: the row `set_kill_switch` writes. */
  const assistantSwitch = (): ActiveEmergencyDeny => ({
    publicId: "edn_agent",
    denyKind: "resource_scope",
    capabilityId: null,
    resourceScopeDigest: resourceScopeDigestOf({
      kind: "agent",
      id: ASSISTANT.agentId,
    }),
    principalId: null,
    reason: "incident",
  });
  const PARITY: [string, ParityScenario][] = [
    ["no agent run, no narrowing", { agentRun: null, opts: {} }],
    ["allowlist", { agentRun: null, opts: { allowlist: new Set(["capB"]) } }],
    [
      "exclusion",
      { agentRun: null, opts: { excludeCapabilities: new Set(["capA"]) } },
    ],
    ["risk ceiling", { agentRun: null, opts: { riskCeiling: "low" } }],
    ["observer ceiling", { agentRun: "observer", opts: {} }],
    ["contributor ceiling", { agentRun: "contributor", opts: {} }],
    [
      "contributor ceiling under a risk ceiling",
      { agentRun: "contributor", opts: { riskCeiling: "medium" } },
    ],
    ["agent run without a resolution", { agentRun: "unresolved", opts: {} }],
    [
      "contributor ceiling under a kill switch on capA",
      {
        agentRun: "contributor",
        opts: {},
        emergencyDenies: [killSwitch("capA")],
      },
    ],
    [
      "kill switch naming the agent principal",
      {
        agentRun: "contributor",
        opts: {},
        emergencyDenies: [killSwitch("fill_form", AGENT_PRN)],
      },
    ],
    [
      "kill switch naming another principal leaves the belt whole",
      {
        agentRun: "contributor",
        opts: {},
        emergencyDenies: [killSwitch("capA", "prn_someone_else")],
      },
    ],
    // R4 (#3370, finding 9): a person's turn, the in-app assistant's, carries
    // no agent run. A switch that names no principal still cuts its tool.
    [
      "a person's turn under a kill switch on capA",
      { agentRun: null, opts: {}, emergencyDenies: [killSwitch("capA")] },
    ],
    [
      "a kill switch naming a principal leaves a person's belt whole",
      {
        agentRun: null,
        opts: {},
        emergencyDenies: [killSwitch("capA", AGENT_PRN)],
      },
    ],
    // The in-app assistant's turn also answers to the agent it runs as: a
    // deny naming that agent's principal, or an `agent` switch on it.
    [
      "the assistant's turn under a deny naming its agent's principal",
      {
        agentRun: null,
        opts: { actingAgent: ASSISTANT },
        emergencyDenies: [killSwitch("capA", ASSISTANT.principalId)],
      },
    ],
    [
      "the assistant's turn under an agent switch on its agent",
      {
        agentRun: null,
        opts: { actingAgent: ASSISTANT },
        emergencyDenies: [assistantSwitch()],
      },
    ],
    [
      "an agent switch on the assistant leaves a person's own belt whole",
      { agentRun: null, opts: {}, emergencyDenies: [assistantSwitch()] },
    ],
  ];
  it.each(PARITY)(
    "lists exactly the tools the shared belt decision keeps: %s",
    async (_name, scenario) => {
      const resolution =
        scenario.agentRun === "observer"
          ? createAgentRunResolution(observerSnapshot())
          : scenario.agentRun === "contributor"
            ? createAgentRunResolution(contributorSnapshot())
            : undefined;
      const agentRun =
        scenario.agentRun === null ? null : makeAgentRun(resolution);
      const ctx = agentRun === null ? CTX : ctxWith(agentRun);
      const emergencyDenies = scenario.emergencyDenies ?? [];
      iamMocks.readActiveEmergencyDenies.mockClear();
      iamMocks.readActiveEmergencyDenies.mockResolvedValue(emergencyDenies);
      const { tools, governance, nameMap } = await materializeTools(
        ctx,
        scenario.opts,
      );
      // The read happens once for every caller, a person's turn included. A
      // fail-closed run skips it: it lists no capability tool a switch could
      // cut.
      expect(iamMocks.readActiveEmergencyDenies).toHaveBeenCalledTimes(
        scenario.agentRun === "unresolved" ? 0 : 1,
      );
      // A person's turn carries no principal ids, so only a deny that names
      // no principal reaches it. The assistant's turn carries its agent's.
      const principals: string[] =
        agentRun !== null
          ? [AGENT_PRN, HUMAN_PRN]
          : scenario.opts.actingAgent
            ? [ASSISTANT.principalId]
            : [];
      for (const deny of emergencyDenies) {
        if (deny.capabilityId === null) continue;
        const name = deny.capabilityId;
        if (deny.principalId === null || principals.includes(deny.principalId))
          expect(tools[name]).toBeUndefined();
        else expect(tools[name]).toBeDefined();
      }
      const listed = Object.keys(tools)
        .map((alias) => nameMap[alias] ?? alias)
        .sort();

      const scope = {
        kind: "workspace" as const,
        orgId: CTX.orgId,
        workspaceId: CTX.workspaceId,
      };
      // The file's own fixture and a static import of the decision: a
      // `vi.resetModules()` + `vi.doMock` in an earlier suite must not swap
      // the registry under one side of the comparison.
      const decided = (FIXTURE as unknown as RegistryCapability[]).map(
        (cap) => ({
          cap,
          decision: decideCapabilityForBelt(cap, {
            surfaces: cap.surfaces ?? ["api", "mcp"],
            excluded: scenario.opts.excludeCapabilities,
            allowlist: scenario.opts.allowlist,
            riskCeiling: scenario.opts.riskCeiling,
            agentRun,
            resolution: resolution ?? null,
            scope,
            now: new Date(),
            clientIp: null,
            emergencyDenies,
            actingAgent: scenario.opts.actingAgent ?? null,
            entitledPluginIds: new Set<string>(),
          }),
        }),
      );
      const kept = decided
        .filter((d) => d.decision.outcome !== "deny")
        .map((d) => d.cap.name)
        .sort();
      expect(listed).toEqual(kept);
      // The declared governance per tool is the decision's own risk and
      // read-only facts, so the record and the engine read one source.
      for (const { cap, decision } of decided) {
        if (decision.outcome === "deny") continue;
        const alias =
          Object.entries(nameMap).find(([, n]) => n === cap.name)?.[0] ??
          cap.name;
        expect(governance[alias]).toMatchObject({
          riskLevel: decision.riskLevel,
          readOnly: decision.readOnly,
        });
      }
    },
  );

  it("an agent switch on the assistant empties the assistant's capability belt and reaches its call gate, and leaves a person's own turn alone", async () => {
    iamMocks.readActiveEmergencyDenies.mockResolvedValue([assistantSwitch()]);
    killSwitchMocks.actingAgents.length = 0;

    const assistantTurn = await materializeTools(CTX, {
      actingAgent: ASSISTANT,
    });
    expect(Object.keys(assistantTurn.tools)).toEqual([]);
    const personTurn = await materializeTools(CTX);
    expect(Object.keys(personTurn.tools).sort()).toEqual([
      "capA",
      "capB",
      "fill_form",
    ]);
    // The call gate of the assistant's turn carries its agent, so the switch
    // refuses the call there too (kill-switch-gate.test.ts). A person's gate
    // carries none.
    expect(killSwitchMocks.actingAgents).toEqual([ASSISTANT, null]);
  });
});

// ── Agent RBAC Phase 4a: MCP rule enforcement (spec §3.7) ────────────────────
// The run's effective resourceScope.mcp rules ({pattern: "server:tool" glob,
// effect: allow|deny|ask}, first-match-wins) govern external MCP tools at TWO
// seams: listing (deny → never registered, the model cannot SEE it) and
// execution (deny → blocked + audited even if the tool somehow reached the
// model; ask → the existing mcp_consents flow with the AGENT PRINCIPAL as the
// consent subject). No agentRun → both seams inert (the user-consent
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
    vi.mocked(emitExternalCapabilityOutcome).mockClear();
    vi.mocked(authorizeExternalCapability).mockResolvedValue({
      allowed: true,
      outcome: "allow",
      reason: null,
      decision: null,
    });
    fakeExecute.mockClear();
    mocks.insertToolInvocation.mockClear();
    mocks.insertToolInvocation.mockResolvedValue(undefined);
    mocks.createApprovalRequest.mockClear();
    mocks.createApprovalRequest.mockResolvedValue({
      approvalId: "appr_ask",
      publicId: "apr_ask",
    });
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
    iamMocks.readActiveEmergencyDenies.mockResolvedValue([]);

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

    // Consent lookups used the AGENT subject: principal id + "agent" kind —
    // once at listing (no record: the tool stays visible) and once at the
    // call; the user-scoped gate was skipped.
    expect(consentMocks.checkConsent).toHaveBeenCalledTimes(2);
    for (const call of consentMocks.checkConsent.mock.calls) {
      expect(call).toEqual([
        ctx,
        AGENT_PRN,
        MCP_SERVER.id,
        "list_pull_requests",
        "agent",
      ]);
    }
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

  it("ask: the consent card carries the risk level the engine is told", async () => {
    const ctx = {
      ...CTX,
      messageId: "msg_ask_risk",
      agentRun: makeMcpAgentRun([{ pattern: "github:*", effect: "ask" }]),
    };
    const { tools, governance } = await materializeTools(ctx);
    await (tools[ALIAS] as { execute?: (i: unknown) => Promise<unknown> })
      .execute!({});
    expect(governance[ALIAS]?.riskLevel).toBe("high");
    expect(mocks.createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(mocks.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityName: SYNTHETIC,
        riskLevel: governance[ALIAS]?.riskLevel,
      }),
    );
  });

  it("ask: an active agent-subject grant runs inline — no card, no audit, no user gate", async () => {
    consentMocks.checkConsent.mockResolvedValue({
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
    // Once at listing, once at the call.
    expect(consentMocks.checkConsent).toHaveBeenCalledTimes(2);
    expect(fakeExecute).toHaveBeenCalledTimes(1);
  });

  // Toolbelt parity (#2956, ADR-057): `get_agent_toolbelt` decides an MCP
  // tool with the agent principal's standing consent; the listing reads the
  // same record for an ask rule, so a tool the console reports under
  // `cannotSee: consent` is one the model is not given.
  it("listing: an ask rule reads the agent principal's standing consent — a recorded denial hides the tool; a grant or no record keeps it; allow and deny rules read none", async () => {
    const ask = () => ({
      ...CTX,
      agentRun: makeMcpAgentRun([{ pattern: "github:*", effect: "ask" }]),
    });
    consentMocks.checkConsent.mockResolvedValue({
      status: "denied",
      active: true,
    });
    const denied = await materializeTools(ask());
    expect(denied.tools[ALIAS]).toBeUndefined();
    expect(consentMocks.checkConsent).toHaveBeenCalledTimes(1);
    expect(consentMocks.checkConsent).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: CTX.orgId }),
      AGENT_PRN,
      MCP_SERVER.id,
      "list_pull_requests",
      "agent",
    );

    consentMocks.checkConsent.mockClear();
    consentMocks.checkConsent.mockResolvedValue({
      status: "granted",
      active: true,
    });
    const granted = await materializeTools(ask());
    expect(granted.tools[ALIAS]).toBeDefined();

    consentMocks.checkConsent.mockClear();
    consentMocks.checkConsent.mockResolvedValue(null);
    const unrecorded = await materializeTools(ask());
    expect(unrecorded.tools[ALIAS]).toBeDefined();

    consentMocks.checkConsent.mockClear();
    for (const effect of ["allow", "deny"] as const) {
      await materializeTools({
        ...CTX,
        agentRun: makeMcpAgentRun([{ pattern: "github:*", effect }]),
      });
    }
    expect(consentMocks.checkConsent).not.toHaveBeenCalled();
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

describe("digestInputFor", () => {
  // The approval row and the ensuing invocation must key on the SAME value.
  // invoke() digests cap.input.safeParse(raw).data, so an approval digested
  // from the raw tool arguments keys on a different value whenever the schema
  // changes the input at all -- and standingWindowMs then matches nothing, so
  // a second person is asked to approve a call that was just approved.
  //
  // Each case below is a way a Zod schema changes its input. They are listed
  // one per kind rather than as "schemas that transform", because the first
  // version of this reasoning said "the same object is handed to invoke()"
  // and that is true and beside the point: the kernel parses in between, so
  // object identity at the call site says nothing about value identity at
  // the gate.
  const cap = (input: unknown) => ({ input }) as never;

  it("applies a default the raw arguments omit", () => {
    const schema = z.object({ a: z.string(), n: z.number().default(7) });
    expect(digestInputFor(cap(schema), { a: "x" })).toEqual({ a: "x", n: 7 });
  });

  it("applies a coercion", () => {
    const schema = z.object({ n: z.coerce.number() });
    expect(digestInputFor(cap(schema), { n: "42" })).toEqual({ n: 42 });
  });

  it("applies a transform", () => {
    const schema = z.object({ s: z.string().transform((v) => v.trim()) });
    expect(digestInputFor(cap(schema), { s: "  hi  " })).toEqual({ s: "hi" });
  });

  it("strips a key the schema does not declare", () => {
    const schema = z.object({ a: z.string() });
    expect(digestInputFor(cap(schema), { a: "x", extra: 1 })).toEqual({
      a: "x",
    });
  });

  it("passes an already-canonical input through unchanged", () => {
    const schema = z.object({ a: z.string() });
    expect(digestInputFor(cap(schema), { a: "x" })).toEqual({ a: "x" });
  });

  it("falls back to the raw value when the input does not parse", () => {
    // invoke() refuses this input, so no window is ever read for its digest.
    const schema = z.object({ a: z.string() });
    expect(digestInputFor(cap(schema), { a: 1 })).toEqual({ a: 1 });
  });
});
