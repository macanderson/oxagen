import { getScope } from "@oxagen/tenancy";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";
import {
  Actor,
  ArchiveExport,
  AuditEvent,
  Day,
  ErasureRequest,
  Incident,
  IncidentKind,
  Notification,
  PublicId,
  RetentionTier,
  Severity,
} from "@/data/contracts";
import { denied, type Read, readError, readOk } from "@/data/not-backed";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import type { ToolContract } from "@/server/invoke";
import {
  COLLECTOR_ONLY_INCIDENT_KINDS,
  type DecisionRow,
  type ErasureRow,
  type ExportRow,
  type IncidentRow,
  type NotificationRow,
  type RetentionPosture,
  type SecurityEventRow,
} from "./mappers/audit";

const kernel = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(
      readonly capability: string,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    CapabilityError,
    invoke:
      vi.fn<
        (name: string, input: unknown, ctx: Record<string, unknown>) => unknown
      >(),
    getCapability: vi.fn<(name: string) => object | undefined>(),
    getSession: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
    orgRole: vi.fn<(orgId: string, userId: string) => Promise<string | null>>(),
    chSelect: vi.fn<(q: { query: string; params?: object }) => unknown>(),
    captureError: vi.fn<(input: object) => void>(),
    registered: [] as string[],
  };
});

vi.mock("@oxagen/oxagen", () => ({
  CapabilityError: kernel.CapabilityError,
  invoke: kernel.invoke,
  getCapability: kernel.getCapability,
}));
vi.mock("@oxagen/handlers/register", () => {
  kernel.registered.push("handlers");
  return {};
});
vi.mock("@/server/session", () => ({ getSession: kernel.getSession }));
vi.mock("@/server/tenancy-lookups", () => ({
  liveTenancyLookups: { orgRole: kernel.orgRole },
}));
vi.mock("@oxagen/telemetry", () => ({
  chSelect: kernel.chSelect,
  captureError: kernel.captureError,
}));

// A drizzle transaction stand-in: every builder call chains, `from` records the
// table read, and awaiting the chain pops the next scripted result — or, when a
// test sets `resolver`, asks it for the rows that table shows under the tenant
// scope the transaction was opened in (a stand-in for RLS).
type Resolver = (
  table: unknown,
  scope: { orgId: string; workspaceId: string },
) => unknown[];
const db = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const tables: unknown[] = [];
  const scopes: unknown[] = [];
  const reads: { table: unknown; scope: unknown }[] = [];
  const state = { resolver: null as Resolver | null };
  const chain = (scope: unknown, table?: unknown): unknown =>
    new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === "then")
          return (
            resolve: (v: unknown) => unknown,
            reject: (e: unknown) => unknown,
          ) =>
            Promise.resolve(
              state.resolver
                ? state.resolver(
                    table,
                    scope as { orgId: string; workspaceId: string },
                  )
                : (queue.shift() ?? []),
            ).then(resolve, reject);
        return (...args: unknown[]) => {
          if (prop === "from") {
            tables.push(args[0]);
            reads.push({ table: args[0], scope });
            return chain(scope, args[0]);
          }
          return chain(scope, table);
        };
      },
    });
  return { queue, tables, scopes, reads, state, chain };
});

vi.mock("@oxagen/database", async () => {
  const { getScope: scopeNow } = await import("@oxagen/tenancy");
  return {
    schema: await vi.importActual("@oxagen/database/schema"),
    withTenantDb: (fn: (tx: unknown) => unknown) => {
      const scope = scopeNow();
      db.scopes.push(scope);
      return fn(db.chain(scope));
    },
  };
});

import * as schema from "@oxagen/database/schema";
import {
  AUDIT_ROLES,
  AuditContractMismatch,
  type AuditStores,
  type AuditViews,
  createLiveAudit,
  EVENTS_LIMIT,
  liveAudit,
  liveAuditStores,
  liveNotifications,
  NOTIFICATIONS_LIMIT,
  ROWS_LIMIT,
} from "./audit";

const SCOPE = {
  orgId: "895c77a7-69de-4f1e-8c05-590ed0c429e8",
  workspaceId: "ad5ae30b-0726-453c-a073-12fbe76f7e16",
};
const ORG_SCOPE = { orgId: SCOPE.orgId, workspaceId: ORG_ONLY_WORKSPACE_ID };
const OTHER_WS = "b686d6a9-cf49-45b4-8206-7a57b19c047a";
const VIEWER = "c054152a-89b3-4abd-bfde-f38af7ec7e2d";
const VIEWER_PUBLIC_ID = "usr_vp6svqpb97xctc74y950ng";

// The promote proposal (see mappers/audit.test.ts): the view models accept null
// where the stores record nothing, so every method runs end to end.
const PROMOTED = {
  AuditEvent: AuditEvent.extend({
    actor: Actor.nullable(),
    summary: z.string().nullable(),
    severity: Severity.nullable(),
    ref: z.string().nullable(),
  }),
  Incident: Incident.extend({
    kind: z.union([IncidentKind, z.enum(COLLECTOR_ONLY_INCIDENT_KINDS)]),
    title: z.string().nullable(),
    detail: z.string().nullable(),
    resolution: z.string().nullable(),
    scope: z.string().nullable(),
  }),
  ArchiveExport: ArchiveExport.extend({
    description: z.string().nullable(),
    from: Day.nullable(),
    to: Day.nullable(),
    contents: z.string().nullable(),
    size: z.string().nullable(),
    createdById: PublicId.nullable(),
    status: ArchiveExport.shape.status.nullable(),
    keys: z.string().nullable(),
  }),
  ErasureRequest: ErasureRequest.extend({
    subject: z.string().nullable(),
    requestedById: PublicId.nullable(),
    status: ErasureRequest.shape.status.nullable(),
  }),
  RetentionTier: RetentionTier.extend({
    store: z.string().nullable(),
    contents: z.string().nullable(),
    retention: z.string().nullable(),
    volume: z.string().nullable(),
  }),
  Notification: Notification.extend({
    tone: Notification.shape.tone.nullable(),
    body: z.string().nullable(),
  }),
} as unknown as AuditViews;

// Real rows from the local stack (security.security_events, the audit_events
// decision shape for an agent-invoked capability), and store rows column for
// column for the stores the local stack holds none of yet.
const BUDGET_EVENT: SecurityEventRow = {
  source: "security",
  eventType: "billing.budget_updated",
  occurredAt: "2026-08-24T01:46:36.292Z",
  actorUserId: VIEWER,
  workspaceId: SCOPE.workspaceId,
  capability: "set_spend_budget",
  outcome: "success",
  requestId: "e93feba4-08e0-4647-a78e-2a0b117efd3d",
};
const ROLE_EVENT: SecurityEventRow = {
  ...BUDGET_EVENT,
  eventType: "capability.invoke_allowed",
  occurredAt: "2026-08-24T01:40:00.000Z",
  capability: "assign_agent_role",
  requestId: "eebeee3d-ba11-4e31-8920-230903d8eeba",
};
const SIGN_IN_FAILED: SecurityEventRow = {
  ...BUDGET_EVENT,
  eventType: "auth.sign_in_failed",
  occurredAt: "2026-08-24T01:30:00.000Z",
  actorUserId: null,
  workspaceId: null,
  capability: null,
  outcome: "deny",
  requestId: "not-a-uuid",
};
const AGENT_DECISION: DecisionRow = {
  requestId: ROLE_EVENT.requestId ?? "",
  capability: "assign_agent_role",
  actingPrincipalKind: "agent",
  targetKind: "agent",
  targetId: "agt_9bn4fpe5th01qem8478m3z",
  principal: {
    kind: "agent",
    displayName: "E2E RBAC Agent",
    userPublicId: null,
    agentKey: "e2erb5.defaul.rbac-mtxbbpju",
  },
};
const feed = (events: SecurityEventRow[]) => ({
  events,
  total: events.length,
  hasMore: false,
  limit: EVENTS_LIMIT,
  offset: 0,
});

const incident = (over: Partial<IncidentRow> = {}): IncidentRow => ({
  publicId: "tin_5k2m9q4r7t1w3y6z8a0c2e",
  kind: "hooks_removed",
  severity: 10,
  detectedAt: new Date("2026-09-11T08:40:00.000Z"),
  detectedBy: "collector",
  resolvedAt: null,
  resolutionNote: null,
  agentKey: "e2eavg.defaul.release-manager",
  hostname: "mbell-mbp-16",
  sessionPublicId: "tse_3pb7whjgdscp26005pstmc",
  resolvedByPublicId: null,
  ...over,
});
const ERASURE: ErasureRow = {
  publicId: "preras_7w2m4q9r1t3y5z8a0c2e4g",
  scope: "user",
  status: "queued",
  createdAt: new Date("2026-09-10T11:00:00.000Z"),
  scheduledAt: new Date("2026-10-10T11:00:00.000Z"),
  completedAt: null,
  errorMessage: null,
  requesterPublicId: VIEWER_PUBLIC_ID,
  orgPublicId: "org_2g4q6s8u0w2y4a6c8e0g2i",
};
const EXPORT: ExportRow = {
  publicId: "prexp_4k6m8p0r2t4v6x8z0b2d4f",
  scope: "org",
  status: "ready",
  createdAt: new Date("2026-09-09T15:30:00.000Z"),
  requesterPublicId: VIEWER_PUBLIC_ID,
};
const POSTURE: RetentionPosture = {
  includedMonths: 12,
  effectiveRetentionDays: 400,
  extendedRetentionEnabled: false,
  usdPerGbMonth: 0.02,
  storedGbBeyondIncluded: null,
  storedGbMeasured: false,
  creditsChargedThisPeriod: 0,
};
const NOTIFICATION: NotificationRow = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  publicId: "ntf_1b3d5f7h9k1m3p5r7t9v1x",
  kind: "approval",
  title: "release-manager is waiting on an approval",
  body: "github__create_release@2 needs a decision.",
  deepLink: "/acme/core-platform/runs/run_01K5RS8Q2M",
  unread: true,
  archived: false,
  createdAt: "2026-09-11T09:14:02.000Z",
};

type ToolCall = { tool: string; input: unknown; permission: string };

type StoreMocks = { [K in keyof AuditStores]: Mock };

function fakeStores(over: Partial<StoreMocks> = {}) {
  const tools = new Map<string, Read<unknown>>();
  const calls: ToolCall[] = [];
  const mocks: StoreMocks = {
    viewerId: vi.fn(() => Promise.resolve(VIEWER)),
    orgRole: vi.fn(() => Promise.resolve("owner")),
    readTool: vi.fn(
      (
        _scope: unknown,
        _userId: string,
        contract: { name: string },
        input: unknown,
        permission: string,
      ) => {
        calls.push({ tool: contract.name, input, permission });
        return Promise.resolve(
          tools.get(contract.name) ?? readError("unscripted_tool", 500),
        );
      },
    ),
    decisions: vi.fn(() => Promise.resolve([AGENT_DECISION])),
    userPublicIds: vi.fn(() =>
      Promise.resolve(new Map([[VIEWER, VIEWER_PUBLIC_ID]])),
    ),
    workspaceIds: vi.fn(() => Promise.resolve([SCOPE.workspaceId])),
    incidents: vi.fn(() => Promise.resolve([incident()])),
    erasureRequests: vi.fn(() => Promise.resolve([ERASURE])),
    exportRequests: vi.fn(() => Promise.resolve([EXPORT])),
    ...over,
  };
  const stores = mocks as unknown as AuditStores;
  return { stores, mocks, tools, calls };
}

const NOT_BACKED_M0 = {
  ok: false,
  reason: "not_backed",
  milestone: "M0",
  gap: "G0",
};

describe("audit.events", () => {
  it("reads query_audit_log as the viewer and draws each actor from its decision", async () => {
    const { stores, mocks, tools, calls } = fakeStores();
    tools.set(
      "query_audit_log",
      readOk(feed([BUDGET_EVENT, ROLE_EVENT, SIGN_IN_FAILED])),
    );
    const { audit } = createLiveAudit({ stores, views: PROMOTED });

    await expect(audit.events(ORG_SCOPE)).resolves.toEqual(
      readOk([
        {
          at: "2026-08-24T01:46:36.292Z",
          kind: "billing.budget_updated",
          actor: { kind: "person", personId: VIEWER_PUBLIC_ID },
          summary: null,
          severity: null,
          ref: null,
        },
        {
          at: "2026-08-24T01:40:00.000Z",
          kind: "capability.invoke_allowed",
          actor: { kind: "agent", agentKey: "e2erb5.defaul.rbac-mtxbbpju" },
          summary: null,
          severity: null,
          ref: "agt_9bn4fpe5th01qem8478m3z",
        },
        {
          at: "2026-08-24T01:30:00.000Z",
          kind: "auth.sign_in_failed",
          actor: null,
          summary: null,
          severity: null,
          ref: null,
        },
      ]),
    );
    expect(calls).toEqual([
      {
        tool: "query_audit_log",
        input: { source: "all", limit: EVENTS_LIMIT, offset: 0 },
        permission: "org.auditor",
      },
    ]);
    // Only invocations with a uuid request id and a capability are joined.
    // Each carries the workspace it ran in, where its principal is visible.
    expect(mocks.decisions).toHaveBeenCalledWith(ORG_SCOPE, [
      {
        requestId: BUDGET_EVENT.requestId,
        capability: "set_spend_budget",
        workspaceId: SCOPE.workspaceId,
      },
      {
        requestId: ROLE_EVENT.requestId,
        capability: "assign_agent_role",
        workspaceId: SCOPE.workspaceId,
      },
    ]);
    expect(mocks.userPublicIds).toHaveBeenCalledWith(ORG_SCOPE, [VIEWER]);
  });

  it("is not backed under today's view model, which has no null severity or summary", async () => {
    const { stores, tools } = fakeStores();
    tools.set("query_audit_log", readOk(feed([BUDGET_EVENT])));
    const { audit } = createLiveAudit({ stores });
    await expect(audit.events(ORG_SCOPE)).resolves.toEqual(NOT_BACKED_M0);
  });

  it("serves an empty feed live, without joining anything", async () => {
    const { stores, mocks, tools } = fakeStores();
    tools.set("query_audit_log", readOk(feed([])));
    const { audit } = createLiveAudit({ stores });
    await expect(audit.events(ORG_SCOPE)).resolves.toEqual(readOk([]));
    expect(mocks.decisions).not.toHaveBeenCalled();
    expect(mocks.userPublicIds).not.toHaveBeenCalled();
  });

  it("denies a request without a session before reading", async () => {
    const { stores, mocks } = fakeStores({
      viewerId: vi.fn(() => Promise.resolve(null)),
    });
    const { audit } = createLiveAudit({ stores, views: PROMOTED });
    await expect(audit.events(ORG_SCOPE)).resolves.toEqual(
      denied("org.auditor"),
    );
    expect(mocks.readTool).not.toHaveBeenCalled();
  });

  it("passes the kernel's denial through", async () => {
    const { stores, mocks, tools } = fakeStores();
    tools.set("query_audit_log", denied("org.auditor"));
    const { audit } = createLiveAudit({ stores, views: PROMOTED });
    await expect(audit.events(ORG_SCOPE)).resolves.toEqual(
      denied("org.auditor"),
    );
    expect(mocks.decisions).not.toHaveBeenCalled();
  });

  it("returns the page's named error and reports it when a store fails", async () => {
    const boom = new Error("clickhouse unreachable");
    const { stores, tools } = fakeStores({
      decisions: vi.fn(() => Promise.reject(boom)),
    });
    tools.set("query_audit_log", readOk(feed([BUDGET_EVENT])));
    const report = vi.fn<(error: unknown, context: string) => void>();
    const { audit } = createLiveAudit({ stores, views: PROMOTED, report });
    await expect(audit.events(ORG_SCOPE)).resolves.toEqual(
      readError("audit_store_unavailable", 503),
    );
    expect(report).toHaveBeenCalledWith(boom, "audit.events");
  });

  it("reports a refusal on a recorded field as a mapping bug, never as not backed", async () => {
    const { stores, tools } = fakeStores();
    tools.set(
      "query_audit_log",
      readOk(feed([{ ...BUDGET_EVENT, eventType: "Billing Budget Updated" }])),
    );
    const report = vi.fn<(error: unknown, context: string) => void>();
    const { audit } = createLiveAudit({ stores, report });
    await expect(audit.events(ORG_SCOPE)).resolves.toEqual(
      readError("contract_output_mismatch", 502),
    );
    const [error, context] = report.mock.calls[0] ?? [];
    expect(context).toBe("audit.events");
    expect(error).toBeInstanceOf(AuditContractMismatch);
    expect((error as AuditContractMismatch).paths).toEqual(["kind"]);
  });
});

describe("audit.incidents", () => {
  it("reads every workspace of an organization and merges them newest first", async () => {
    const older = incident({
      publicId: "tin_older00000000000000000",
      kind: "daemon_down",
      severity: 3,
      detectedBy: "control_plane",
      detectedAt: new Date("2026-09-10T08:00:00.000Z"),
      resolvedAt: new Date("2026-09-10T09:00:00.000Z"),
      resolutionNote: "Daemon restarted.",
      resolvedByPublicId: "prn_cv6302ky39te607290f12d",
    });
    const { stores, mocks } = fakeStores({
      workspaceIds: vi.fn(() => Promise.resolve([SCOPE.workspaceId, OTHER_WS])),
      incidents: vi.fn((scope: { workspaceId: string }) =>
        Promise.resolve(
          scope.workspaceId === OTHER_WS ? [incident()] : [older],
        ),
      ),
    });
    const { audit } = createLiveAudit({ stores, views: PROMOTED });
    const read = await audit.incidents(ORG_SCOPE);
    expect(read.ok && read.value.map((i) => i.id)).toEqual([
      "tin_5k2m9q4r7t1w3y6z8a0c2e",
      "tin_older00000000000000000",
    ]);
    expect(mocks.incidents).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
    });
    expect(mocks.incidents).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      workspaceId: OTHER_WS,
    });
    expect(read).toMatchObject({
      ok: true,
      value: [
        { status: "open", runIds: ["tse_3pb7whjgdscp26005pstmc"] },
        {
          kind: "daemon_down",
          status: "resolved",
          closedBy: "prn_cv6302ky39te607290f12d",
        },
      ],
    });
  });

  it("caps the merged list", async () => {
    const many = Array.from({ length: ROWS_LIMIT + 5 }, (_, i) =>
      incident({
        publicId: `tin_n${String(i)}`,
        detectedAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
      }),
    );
    const { stores } = fakeStores({
      incidents: vi.fn(() => Promise.resolve(many)),
    });
    const { audit } = createLiveAudit({ stores, views: PROMOTED });
    const read = await audit.incidents(ORG_SCOPE);
    expect(read.ok && read.value.length).toBe(ROWS_LIMIT);
    expect(read.ok && read.value[0]?.id).toBe(`tin_n${String(ROWS_LIMIT + 4)}`);
  });

  it("is not backed while a collector kind or a missing title reaches today's view model", async () => {
    const { stores } = fakeStores();
    const { audit } = createLiveAudit({ stores });
    await expect(audit.incidents(ORG_SCOPE)).resolves.toEqual(NOT_BACKED_M0);
  });

  it.each(["owner", "admin", "compliance"])(
    "lets an organization %s read",
    async (role) => {
      const { stores } = fakeStores({
        orgRole: vi.fn(() => Promise.resolve(role)),
      });
      const { audit } = createLiveAudit({ stores, views: PROMOTED });
      await expect(audit.incidents(ORG_SCOPE)).resolves.toMatchObject({
        ok: true,
      });
    },
  );

  it.each(["member", "billing", "viewer", null])(
    "denies an organization role of %s before reading the store",
    async (role) => {
      const { stores, mocks } = fakeStores({
        orgRole: vi.fn(() => Promise.resolve(role)),
      });
      const { audit } = createLiveAudit({ stores, views: PROMOTED });
      await expect(audit.incidents(ORG_SCOPE)).resolves.toEqual(
        denied("org.auditor"),
      );
      expect(mocks.workspaceIds).not.toHaveBeenCalled();
      expect(mocks.incidents).not.toHaveBeenCalled();
    },
  );

  it("denies without a session", async () => {
    const { stores, mocks } = fakeStores({
      viewerId: vi.fn(() => Promise.resolve(null)),
    });
    const { audit } = createLiveAudit({ stores, views: PROMOTED });
    await expect(audit.incidents(ORG_SCOPE)).resolves.toEqual(
      denied("org.auditor"),
    );
    expect(mocks.orgRole).not.toHaveBeenCalled();
  });

  it("the auditor roles are exactly owner, admin and compliance", () => {
    expect([...AUDIT_ROLES].sort()).toEqual(["admin", "compliance", "owner"]);
  });
});

describe("audit.exports and audit.erasure", () => {
  it("maps export requests", async () => {
    const { stores, mocks } = fakeStores();
    const { audit } = createLiveAudit({ stores, views: PROMOTED });
    await expect(audit.exports(ORG_SCOPE)).resolves.toMatchObject({
      ok: true,
      value: [{ id: EXPORT.publicId, status: "ready", from: null, size: null }],
    });
    expect(mocks.exportRequests).toHaveBeenCalledWith(ORG_SCOPE);
  });

  it("maps erasure requests, and today's view model already carries a pending one", async () => {
    const { stores } = fakeStores();
    await expect(
      createLiveAudit({ stores }).audit.erasure(ORG_SCOPE),
    ).resolves.toEqual(
      readOk([
        {
          id: ERASURE.publicId,
          subject: VIEWER_PUBLIC_ID,
          requestedAt: "2026-09-10T11:00:00.000Z",
          requestedById: VIEWER_PUBLIC_ID,
          status: "pending",
          effectiveAt: null,
          dueAt: "2026-10-10T11:00:00.000Z",
          scope: "user",
          holdId: null,
          note: null,
        },
      ]),
    );
  });

  it("keeps a completed hard delete not backed rather than reading it as destroyed keys", async () => {
    const { stores } = fakeStores({
      erasureRequests: vi.fn(() =>
        Promise.resolve([{ ...ERASURE, status: "completed" as const }]),
      ),
    });
    await expect(
      createLiveAudit({ stores }).audit.erasure(ORG_SCOPE),
    ).resolves.toEqual(NOT_BACKED_M0);
  });

  it("is not backed for exports under today's view model", async () => {
    const { stores } = fakeStores();
    await expect(
      createLiveAudit({ stores }).audit.exports(ORG_SCOPE),
    ).resolves.toEqual(NOT_BACKED_M0);
  });

  it.each(["exports", "erasure"] as const)(
    "%s denies a member before reading",
    async (method) => {
      const { stores, mocks } = fakeStores({
        orgRole: vi.fn(() => Promise.resolve("member")),
      });
      const { audit } = createLiveAudit({ stores, views: PROMOTED });
      await expect(audit[method](ORG_SCOPE)).resolves.toEqual(
        denied("org.auditor"),
      );
      expect(mocks.exportRequests).not.toHaveBeenCalled();
      expect(mocks.erasureRequests).not.toHaveBeenCalled();
    },
  );
});

describe("audit.retention", () => {
  it("reads get_evidence_retention as the viewer", async () => {
    const { stores, tools, calls } = fakeStores();
    tools.set("get_evidence_retention", readOk(POSTURE));
    const { audit } = createLiveAudit({ stores, views: PROMOTED });
    await expect(audit.retention(ORG_SCOPE)).resolves.toEqual(
      readOk([
        {
          tier: "bodies",
          store: null,
          contents: null,
          retention: "P400D",
          volume: null,
        },
      ]),
    );
    expect(calls).toEqual([
      { tool: "get_evidence_retention", input: {}, permission: "org.auditor" },
    ]);
  });

  it("is not backed under today's view model", async () => {
    const { stores, tools } = fakeStores();
    tools.set("get_evidence_retention", readOk(POSTURE));
    await expect(
      createLiveAudit({ stores }).audit.retention(ORG_SCOPE),
    ).resolves.toEqual(NOT_BACKED_M0);
  });

  it("denies without a session and passes a kernel denial through", async () => {
    const none = fakeStores({ viewerId: vi.fn(() => Promise.resolve(null)) });
    await expect(
      createLiveAudit({ stores: none.stores }).audit.retention(ORG_SCOPE),
    ).resolves.toEqual(denied("org.auditor"));
    const refused = fakeStores();
    refused.tools.set("get_evidence_retention", denied("org.auditor"));
    await expect(
      createLiveAudit({ stores: refused.stores }).audit.retention(ORG_SCOPE),
    ).resolves.toEqual(denied("org.auditor"));
  });
});

describe("the storeless audit methods", () => {
  const { stores } = fakeStores();
  const { audit } = createLiveAudit({ stores });
  it.each([
    ["receipts", "M5", "G8"],
    ["getReceipt", "M5", "G8"],
    ["holds", "M5", "G8"],
    ["keys", "M5", "G8"],
    ["assuranceHistory", "M2", "G0"],
  ] as const)("%s returns %s %s", async (method, milestone, gap) => {
    const read = (audit[method] as (s: unknown, id?: string) => unknown)(
      ORG_SCOPE,
      "rcp_1",
    );
    await expect(read).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone,
      gap,
    });
  });
});

describe("shell.notifications", () => {
  it("reads list_notifications as the viewer, and today's view model carries an approval", async () => {
    const { stores, tools, calls } = fakeStores();
    tools.set(
      "list_notifications",
      readOk({ notifications: [NOTIFICATION], unreadCount: 1 }),
    );
    const { notifications } = createLiveAudit({ stores });
    await expect(notifications(SCOPE)).resolves.toEqual(
      readOk([
        {
          id: "ntf_1b3d5f7h9k1m3p5r7t9v1x",
          kind: "approval",
          tone: "approval",
          unread: true,
          at: "2026-09-11T09:14:02.000Z",
          title: "release-manager is waiting on an approval",
          body: "github__create_release@2 needs a decision.",
          runId: "run_01K5RS8Q2M",
          ref: "/acme/core-platform/runs/run_01K5RS8Q2M",
        },
      ]),
    );
    expect(calls).toEqual([
      {
        tool: "list_notifications",
        input: { unreadOnly: false, limit: NOTIFICATIONS_LIMIT },
        permission: "org.read",
      },
    ]);
  });

  it("is not backed when a kind carries no tone under today's view model", async () => {
    const { stores, tools } = fakeStores();
    tools.set(
      "list_notifications",
      readOk({
        notifications: [NOTIFICATION, { ...NOTIFICATION, kind: "run" }],
        unreadCount: 2,
      }),
    );
    await expect(
      createLiveAudit({ stores }).notifications(SCOPE),
    ).resolves.toEqual(NOT_BACKED_M0);
    await expect(
      createLiveAudit({ stores, views: PROMOTED }).notifications(SCOPE),
    ).resolves.toMatchObject({ ok: true, value: [{}, { tone: null }] });
  });

  it("denies without a session, and names the shell's store on failure", async () => {
    const none = fakeStores({ viewerId: vi.fn(() => Promise.resolve(null)) });
    await expect(
      createLiveAudit({ stores: none.stores }).notifications(SCOPE),
    ).resolves.toEqual(denied("org.read"));

    const broken = fakeStores({
      readTool: vi.fn(() => Promise.reject(new Error("pool exhausted"))),
    });
    const report = vi.fn<(error: unknown, context: string) => void>();
    await expect(
      createLiveAudit({ stores: broken.stores, report }).notifications(SCOPE),
    ).resolves.toEqual(readError("notification_store_unavailable", 503));
    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      "shell.notifications",
    );
  });
});

// ---- The real stores, over a mocked kernel, transaction and ClickHouse --------

describe("liveAuditStores", () => {
  beforeEach(() => {
    db.queue.length = 0;
    db.tables.length = 0;
    db.scopes.length = 0;
    db.reads.length = 0;
    db.state.resolver = null;
    kernel.getCapability.mockReturnValue({});
  });

  it("reads the viewer from the session", async () => {
    kernel.getSession.mockResolvedValueOnce({ user: { id: VIEWER } });
    await expect(liveAuditStores.viewerId()).resolves.toBe(VIEWER);
    kernel.getSession.mockResolvedValueOnce(null);
    await expect(liveAuditStores.viewerId()).resolves.toBeNull();
  });

  it("asks the tenancy lookups for the organization role", async () => {
    kernel.orgRole.mockResolvedValueOnce("compliance");
    await expect(liveAuditStores.orgRole(SCOPE, VIEWER)).resolves.toBe(
      "compliance",
    );
    expect(kernel.orgRole).toHaveBeenCalledWith(SCOPE.orgId, VIEWER);
  });

  describe("readTool", () => {
    const contract = {
      name: "query_audit_log",
      input: { _input: {}, safeParse: () => ({ success: true, data: {} }) },
      output: {
        _output: { n: 0 },
        safeParse: (v: unknown) =>
          typeof (v as { n?: unknown } | null)?.n === "number"
            ? { success: true as const, data: v as { n: number } }
            : { success: false as const, error: { issues: [] } },
      },
    } as unknown as ToolContract<unknown, { n: number }>;

    it("invokes as the viewer inside the tenant scope and parses the output", async () => {
      let scopeSeen: unknown;
      kernel.invoke.mockImplementationOnce(() => {
        scopeSeen = getScope();
        return { n: 3 };
      });
      await expect(
        liveAuditStores.readTool(SCOPE, VIEWER, contract, { a: 1 }, "p"),
      ).resolves.toEqual(readOk({ n: 3 }));
      expect(kernel.registered).toContain("handlers");
      expect(scopeSeen).toMatchObject(SCOPE);
      const [name, input, ctx] = kernel.invoke.mock.calls[0] ?? [];
      expect(name).toBe("query_audit_log");
      expect(input).toEqual({ a: 1 });
      expect(ctx).toMatchObject({
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        userId: VIEWER,
        apiKeyId: null,
        surface: "app",
      });
    });

    it("refuses a tool output that breaks the tool's own schema", async () => {
      kernel.invoke.mockResolvedValueOnce({ n: "three" });
      await expect(
        liveAuditStores.readTool(SCOPE, VIEWER, contract, {}, "p"),
      ).resolves.toEqual(readError("contract_output_mismatch", 502));
    });

    it.each([
      [
        "a kernel authz denial",
        new kernel.CapabilityError("t", "authz_denied", "no"),
      ],
      [
        "a pending approval",
        new kernel.CapabilityError("t", "pending_approval", "wait"),
      ],
      [
        "the handler's org-wide refusal",
        new Error(
          "Forbidden: the org-wide audit feed requires an org Owner or Admin role",
        ),
      ],
    ])("reads %s as denied", async (_label, error) => {
      kernel.invoke.mockRejectedValueOnce(error);
      await expect(
        liveAuditStores.readTool(SCOPE, VIEWER, contract, {}, "org.auditor"),
      ).resolves.toEqual(denied("org.auditor"));
    });

    it.each([
      [
        "another kernel error",
        new kernel.CapabilityError("t", "invalid_input", "bad"),
      ],
      ["a store failure", new Error("connection refused")],
    ])("rethrows %s", async (_label, error) => {
      kernel.invoke.mockRejectedValueOnce(error);
      await expect(
        liveAuditStores.readTool(SCOPE, VIEWER, contract, {}, "p"),
      ).rejects.toBe(error);
    });

    it("throws for a tool that is not registered", async () => {
      kernel.getCapability.mockReturnValueOnce(undefined);
      await expect(
        liveAuditStores.readTool(SCOPE, VIEWER, contract, {}, "p"),
      ).rejects.toThrow("agent tool not registered: query_audit_log");
    });
  });

  describe("decisions", () => {
    const PRINCIPAL_ID = "7fc508b1-fe9e-4fc4-9edd-e9241905dd30";
    const HUMAN_PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
    const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
    const NIL = "00000000-0000-0000-0000-000000000000";
    const decision = (over: Record<string, unknown>) => ({
      request_id: AGENT_DECISION.requestId,
      capability: "assign_agent_role",
      acting_principal_id: PRINCIPAL_ID,
      acting_principal_kind: "agent",
      target_kind: null,
      target_id: null,
      workspace_id: null,
      ...over,
    });

    // iam.principals is workspace_nullable (null workspace, or the scope's) and
    // agent.agents is standard (the scope's workspace only): an agent resolves
    // only under its own workspace, never under an organization scope.
    const PRINCIPALS = [
      {
        id: PRINCIPAL_ID,
        workspaceId: SCOPE.workspaceId,
        kind: "agent",
        displayName: "E2E RBAC Agent",
        parentUserId: VIEWER,
      },
      {
        id: OTHER_AGENT_ID,
        workspaceId: OTHER_WS,
        kind: "agent",
        displayName: "Release Manager",
        parentUserId: VIEWER,
      },
      {
        id: HUMAN_PRINCIPAL_ID,
        workspaceId: null,
        kind: "human",
        displayName: "Marcus Bell",
        parentUserId: VIEWER,
      },
    ];
    const AGENTS = [
      {
        principalId: PRINCIPAL_ID,
        workspaceId: SCOPE.workspaceId,
        slug: "rbac-mtxbbpju",
        workspaceNamespace: "defaul",
        orgNamespace: "e2erb5",
      },
      {
        principalId: OTHER_AGENT_ID,
        workspaceId: OTHER_WS,
        slug: "release-manager",
        workspaceNamespace: "core",
        orgNamespace: "e2erb5",
      },
    ];
    const rls: Resolver = (table, scope) => {
      const strip = <T extends { workspaceId: string | null }>(rows: T[]) =>
        rows.map(({ workspaceId: _ws, ...row }) => row);
      if (table === schema.principals)
        return strip(
          PRINCIPALS.filter(
            (p) =>
              p.workspaceId === null || p.workspaceId === scope.workspaceId,
          ),
        );
      if (table === schema.agents)
        return strip(AGENTS.filter((a) => a.workspaceId === scope.workspaceId));
      if (table === schema.users)
        return [{ id: VIEWER, publicId: VIEWER_PUBLIC_ID }];
      return [];
    };
    const scopesReading = (table: unknown) =>
      db.reads.flatMap((r) => (r.table === table ? [r.scope] : []));

    it("reads audit_events through chSelect, org-filtered, and keeps only the asked invocations", async () => {
      db.state.resolver = rls;
      kernel.chSelect.mockResolvedValueOnce({
        data: [
          decision({
            target_kind: "agent",
            target_id: "agt_9bn4fpe5th01qem8478m3z",
          }),
          decision({ capability: "list_agent_roles" }),
          decision({
            request_id: BUDGET_EVENT.requestId,
            capability: "set_spend_budget",
            acting_principal_id: HUMAN_PRINCIPAL_ID,
            acting_principal_kind: "human",
          }),
          decision({
            request_id: "22222222-2222-4222-8222-222222222222",
            capability: "set_spend_budget",
            acting_principal_id: NIL,
            acting_principal_kind: "service",
          }),
        ],
      });
      const rows = await liveAuditStores.decisions(ORG_SCOPE, [
        {
          requestId: AGENT_DECISION.requestId,
          capability: "assign_agent_role",
          workspaceId: SCOPE.workspaceId,
        },
        {
          requestId: BUDGET_EVENT.requestId ?? "",
          capability: "set_spend_budget",
          workspaceId: null,
        },
        {
          requestId: "22222222-2222-4222-8222-222222222222",
          capability: "set_spend_budget",
          workspaceId: null,
        },
      ]);

      const [q] = kernel.chSelect.mock.calls[0] ?? [];
      expect(q?.query).toMatch(/FROM audit_events FINAL/);
      expect(q?.query).toMatch(/WHERE org_id = \{orgId:UUID\}/);
      // An alias named like the column would shadow it inside WHERE.
      expect(q?.query).not.toMatch(/\bAS (request_id|acting_principal_id)\b/);
      expect(q?.params).toEqual({
        requestIds: [
          AGENT_DECISION.requestId,
          BUDGET_EVENT.requestId,
          "22222222-2222-4222-8222-222222222222",
        ],
      });
      expect(rows).toEqual([
        AGENT_DECISION,
        {
          requestId: BUDGET_EVENT.requestId,
          capability: "set_spend_budget",
          actingPrincipalKind: "human",
          targetKind: null,
          targetId: null,
          principal: {
            kind: "human",
            displayName: "Marcus Bell",
            userPublicId: VIEWER_PUBLIC_ID,
            agentKey: null,
          },
        },
        {
          requestId: "22222222-2222-4222-8222-222222222222",
          capability: "set_spend_budget",
          // IAM resolved no principal: emitAudit wrote `service` + the nil id.
          actingPrincipalKind: null,
          targetKind: null,
          targetId: null,
          principal: null,
        },
      ]);
    });

    it("resolves an agent under the workspace its event ran in, not the page's organization scope", async () => {
      db.state.resolver = rls;
      kernel.chSelect.mockResolvedValueOnce({
        data: [
          decision({}),
          decision({
            request_id: BUDGET_EVENT.requestId,
            capability: "set_spend_budget",
            acting_principal_id: OTHER_AGENT_ID,
          }),
          decision({
            request_id: "22222222-2222-4222-8222-222222222222",
            capability: "set_spend_budget",
            acting_principal_id: HUMAN_PRINCIPAL_ID,
            acting_principal_kind: "human",
          }),
        ],
      });
      const rows = await liveAuditStores.decisions(ORG_SCOPE, [
        {
          requestId: AGENT_DECISION.requestId,
          capability: "assign_agent_role",
          workspaceId: SCOPE.workspaceId,
        },
        {
          requestId: BUDGET_EVENT.requestId ?? "",
          capability: "set_spend_budget",
          workspaceId: OTHER_WS,
        },
        {
          requestId: "22222222-2222-4222-8222-222222222222",
          capability: "set_spend_budget",
          workspaceId: null,
        },
      ]);

      expect(rows.map((r) => r.principal?.agentKey ?? null)).toEqual([
        "e2erb5.defaul.rbac-mtxbbpju",
        "e2erb5.core.release-manager",
        null,
      ]);
      expect(rows[2]?.principal).toMatchObject({
        kind: "human",
        userPublicId: VIEWER_PUBLIC_ID,
      });
      // One lookup per workspace the events ran in, one for the org-level event.
      expect(scopesReading(schema.agents)).toEqual(
        expect.arrayContaining([
          expect.objectContaining(SCOPE),
          expect.objectContaining({
            orgId: SCOPE.orgId,
            workspaceId: OTHER_WS,
          }),
        ]),
      );
      expect(scopesReading(schema.agents)).not.toContainEqual(
        expect.objectContaining(ORG_SCOPE),
      );
      expect(scopesReading(schema.principals)).toHaveLength(3);
      expect(scopesReading(schema.principals)).toContainEqual(
        expect.objectContaining(ORG_SCOPE),
      );
    });

    it("falls back to the decision's own workspace when the security event recorded none", async () => {
      db.state.resolver = rls;
      kernel.chSelect.mockResolvedValueOnce({
        data: [decision({ workspace_id: SCOPE.workspaceId })],
      });
      const rows = await liveAuditStores.decisions(ORG_SCOPE, [
        {
          requestId: AGENT_DECISION.requestId,
          capability: "assign_agent_role",
          workspaceId: null,
        },
      ]);
      expect(rows[0]?.principal?.agentKey).toBe("e2erb5.defaul.rbac-mtxbbpju");
      expect(scopesReading(schema.principals)).toEqual([
        expect.objectContaining(SCOPE),
      ]);
    });

    it("leaves an agent unresolved when neither record names its workspace", async () => {
      db.state.resolver = rls;
      kernel.chSelect.mockResolvedValueOnce({ data: [decision({})] });
      const [row] = await liveAuditStores.decisions(ORG_SCOPE, [
        {
          requestId: AGENT_DECISION.requestId,
          capability: "assign_agent_role",
          workspaceId: null,
        },
      ]);
      expect(row).toMatchObject({
        actingPrincipalKind: "agent",
        principal: null,
      });
    });

    it("reads nothing for no invocations", async () => {
      await expect(liveAuditStores.decisions(SCOPE, [])).resolves.toEqual([]);
      expect(kernel.chSelect).not.toHaveBeenCalled();
    });
  });

  it("maps user ids to public ids under the tenant scope", async () => {
    db.queue.push([{ id: VIEWER, publicId: VIEWER_PUBLIC_ID }]);
    await expect(
      liveAuditStores.userPublicIds(SCOPE, [VIEWER]),
    ).resolves.toEqual(new Map([[VIEWER, VIEWER_PUBLIC_ID]]));
    expect(db.tables).toEqual([schema.users]);
    expect(db.scopes[0]).toMatchObject(SCOPE);
  });

  it("lists the organization's workspaces for an organization scope, and only its own otherwise", async () => {
    await expect(liveAuditStores.workspaceIds(SCOPE)).resolves.toEqual([
      SCOPE.workspaceId,
    ]);
    expect(db.tables).toEqual([]);
    db.queue.push([{ id: SCOPE.workspaceId }, { id: OTHER_WS }]);
    await expect(liveAuditStores.workspaceIds(ORG_SCOPE)).resolves.toEqual([
      SCOPE.workspaceId,
      OTHER_WS,
    ]);
    expect(db.tables).toEqual([schema.workspaces]);
  });

  it("reads one workspace's incidents with the host's agent key before the session's", async () => {
    const base = {
      publicId: "tin_5k2m9q4r7t1w3y6z8a0c2e",
      kind: "hooks_removed",
      severity: 10,
      detectedAt: new Date("2026-09-11T08:40:00.000Z"),
      detectedBy: "collector",
      resolvedAt: null,
      resolutionNote: null,
      hostname: "mbell-mbp-16",
      sessionPublicId: "tse_3pb7whjgdscp26005pstmc",
      resolvedByPublicId: null,
    };
    db.queue.push([
      { ...base, hostAgentKey: "a.b.host", sessionAgentKey: "a.b.session" },
      { ...base, hostAgentKey: null, sessionAgentKey: "a.b.session" },
    ]);
    const rows = await liveAuditStores.incidents(SCOPE);
    expect(rows.map((r) => r.agentKey)).toEqual(["a.b.host", "a.b.session"]);
    expect(rows[0]).not.toHaveProperty("hostAgentKey");
    expect(db.tables).toEqual([schema.tachoIncidents]);
    expect(db.scopes[0]).toMatchObject(SCOPE);
  });

  it("reads erasure and export requests under the tenant scope", async () => {
    db.queue.push([ERASURE], [EXPORT]);
    await expect(liveAuditStores.erasureRequests(ORG_SCOPE)).resolves.toEqual([
      ERASURE,
    ]);
    await expect(liveAuditStores.exportRequests(ORG_SCOPE)).resolves.toEqual([
      EXPORT,
    ]);
    expect(db.tables).toEqual([
      schema.privacyErasureRequests,
      schema.privacyExportRequests,
    ]);
    expect(db.scopes).toEqual([
      expect.objectContaining(ORG_SCOPE),
      expect.objectContaining(ORG_SCOPE),
    ]);
  });
});

describe("the live source wiring", () => {
  it("serves the audit port and the shell's notifications from this adapter", async () => {
    const { liveSource } = await import("./index");
    expect(liveSource.audit).toBe(liveAudit);
    expect(liveSource.shell).toHaveProperty("notifications", liveNotifications);
  });

  it("reports a store failure to telemetry and returns the page's error", async () => {
    kernel.getSession.mockResolvedValueOnce({ user: { id: VIEWER } });
    kernel.orgRole.mockRejectedValueOnce(new Error("pool exhausted"));
    await expect(liveAudit.incidents(ORG_SCOPE)).resolves.toEqual(
      readError("audit_store_unavailable", 503),
    );
    await vi.waitFor(() => {
      expect(kernel.captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "app",
          severity: "error",
          context: "audit.incidents",
        }),
      );
    });
  });
});
