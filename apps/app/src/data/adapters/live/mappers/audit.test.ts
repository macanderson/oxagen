import { describe, expect, it } from "vitest";
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
import {
  COLLECTOR_ONLY_INCIDENT_KINDS,
  type DecisionRow,
  type ErasureRow,
  type ExportRow,
  type IncidentRow,
  type NotificationRow,
  RECORDED_PROBES,
  type RetentionPosture,
  rejectedPaths,
  type SecurityEventSource,
  toActor,
  toArchiveExport,
  toAuditEvent,
  toErasureRequest,
  toIncident,
  toNotification,
  toRetentionTiers,
  UNRECORDED_PATHS,
} from "./audit";

// The promote proposal: each view model accepts null (or the store's enum
// value) exactly where the store records nothing. c1 owns the contracts; these
// schemas are what its change has to accept for the methods to serve live.
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
  // Severity and body are nullable in the contract: nothing left to promote.
  Notification,
};

const CURRENT = {
  events: AuditEvent,
  incidents: Incident,
  exports: ArchiveExport,
  erasure: ErasureRequest,
  retention: RetentionTier,
  notifications: Notification,
} as const;
const PROMOTED_BY_METHOD = {
  events: PROMOTED.AuditEvent,
  incidents: PROMOTED.Incident,
  exports: PROMOTED.ArchiveExport,
  erasure: PROMOTED.ErasureRequest,
  retention: PROMOTED.RetentionTier,
  notifications: PROMOTED.Notification,
} as const;

// A real row from the local stack: security.security_events for a
// set_spend_budget call (query_audit_log output shape), its actor's
// auth.users.public_id, and the audit_events decision and agent principal
// shape ClickHouse and iam.principals hold for an agent-invoked capability.
const SECURITY_EVENT: SecurityEventSource["event"] = {
  source: "security",
  eventType: "billing.budget_updated",
  occurredAt: "2026-08-24T01:46:36.292Z",
  actorUserId: "c054152a-89b3-4abd-bfde-f38af7ec7e2d",
  workspaceId: "ad5ae30b-0726-453c-a073-12fbe76f7e16",
  capability: "set_spend_budget",
  outcome: "success",
  requestId: "e93feba4-08e0-4647-a78e-2a0b117efd3d",
};
const ACTOR_PUBLIC_ID = "usr_vp6svqpb97xctc74y950ng";
const AGENT_DECISION: DecisionRow = {
  requestId: "eebeee3d-ba11-4e31-8920-230903d8eeba",
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

const INCIDENT: IncidentRow = {
  publicId: "tin_5k2m9q4r7t1w3y6z8a0c2e",
  kind: "hooks_removed",
  severity: 10,
  detectedAt: new Date("2026-09-11T08:40:00.000Z"),
  detectedBy: "collector",
  resolvedAt: new Date("2026-09-11T09:02:00.000Z"),
  resolutionNote: "Hooks restored by the operator.",
  agentKey: "e2eavg.defaul.release-manager",
  hostname: "mbell-mbp-16",
  sessionPublicId: "tse_3pb7whjgdscp26005pstmc",
  resolvedByPublicId: "prn_cv6302ky39te607290f12d",
};

const ERASURE: ErasureRow = {
  publicId: "preras_7w2m4q9r1t3y5z8a0c2e4g",
  scope: "user",
  status: "queued",
  createdAt: new Date("2026-09-10T11:00:00.000Z"),
  scheduledAt: new Date("2026-10-10T11:00:00.000Z"),
  completedAt: null,
  errorMessage: null,
  requesterPublicId: ACTOR_PUBLIC_ID,
  orgPublicId: "org_2g4q6s8u0w2y4a6c8e0g2i",
};

const EXPORT: ExportRow = {
  publicId: "prexp_4k6m8p0r2t4v6x8z0b2d4f",
  scope: "org",
  status: "ready",
  createdAt: new Date("2026-09-09T15:30:00.000Z"),
  requesterPublicId: ACTOR_PUBLIC_ID,
};

const POSTURE: RetentionPosture = {
  includedMonths: 12,
  effectiveRetentionDays: 400,
  extendedRetentionEnabled: true,
  usdPerGbMonth: 0.02,
  storedGbBeyondIncluded: 12.5,
  storedGbMeasured: true,
  creditsChargedThisPeriod: 3,
};

const NOTIFICATION: NotificationRow = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  publicId: "ntf_1b3d5f7h9k1m3p5r7t9v1x",
  kind: "approval",
  title: "release-manager is waiting on an approval",
  body: "github__create_release@2 needs a decision.",
  deepLink: "/acme/core-platform/runs/run_01K5RS8Q2M/approvals",
  unread: true,
  archived: false,
  createdAt: "2026-09-11T09:14:02.000Z",
};

describe("toActor", () => {
  const source = (
    over: Partial<SecurityEventSource> = {},
  ): SecurityEventSource => ({
    event: SECURITY_EVENT,
    actorPublicId: ACTOR_PUBLIC_ID,
    decision: null,
    ...over,
  });

  it("draws an agent-invoked call as the agent, not the person whose session carried it", () => {
    expect(toActor(source({ decision: AGENT_DECISION }))).toEqual({
      kind: "agent",
      agentKey: "e2erb5.defaul.rbac-mtxbbpju",
    });
  });

  it("leaves an agent it cannot key unresolved rather than naming the session's person", () => {
    expect(
      toActor(
        source({
          decision: { ...AGENT_DECISION, principal: null },
        }),
      ),
    ).toBeNull();
  });

  it("names a service principal as a system actor", () => {
    expect(
      toActor(
        source({
          decision: {
            ...AGENT_DECISION,
            actingPrincipalKind: "service",
            principal: {
              kind: "service",
              displayName: "reconciler",
              userPublicId: null,
              agentKey: null,
            },
          },
        }),
      ),
    ).toEqual({ kind: "system", name: "reconciler" });
    expect(
      toActor(
        source({
          decision: {
            ...AGENT_DECISION,
            actingPrincipalKind: "service",
            principal: null,
          },
        }),
      ),
    ).toBeNull();
  });

  it("prefers the human principal's user, then the event's actor", () => {
    const human: DecisionRow = {
      ...AGENT_DECISION,
      actingPrincipalKind: "human",
      principal: {
        kind: "human",
        displayName: "Marcus Bell",
        userPublicId: "usr_principal0000000000001",
        agentKey: null,
      },
    };
    expect(toActor(source({ decision: human }))).toEqual({
      kind: "person",
      personId: "usr_principal0000000000001",
    });
    expect(
      toActor(source({ decision: { ...human, principal: null } })),
    ).toEqual({ kind: "person", personId: ACTOR_PUBLIC_ID });
    expect(
      toActor(
        source({
          decision: { ...human, principal: null },
          actorPublicId: null,
        }),
      ),
    ).toBeNull();
  });

  it("reads a decision with no resolved principal as no decision about who acted", () => {
    expect(
      toActor(
        source({
          decision: {
            ...AGENT_DECISION,
            actingPrincipalKind: null,
            principal: null,
          },
        }),
      ),
    ).toEqual({ kind: "person", personId: ACTOR_PUBLIC_ID });
  });

  it("falls back to the event's actor without a decision, and null without either", () => {
    expect(toActor(source())).toEqual({
      kind: "person",
      personId: ACTOR_PUBLIC_ID,
    });
    expect(toActor(source({ actorPublicId: null }))).toBeNull();
  });
});

describe("toAuditEvent", () => {
  it("maps the real security event column for column and records no severity or prose", () => {
    const event = toAuditEvent({
      event: SECURITY_EVENT,
      actorPublicId: ACTOR_PUBLIC_ID,
      decision: null,
    });
    expect(event).toEqual({
      at: "2026-08-24T01:46:36.292Z",
      kind: "billing.budget_updated",
      actor: { kind: "person", personId: ACTOR_PUBLIC_ID },
      summary: null,
      severity: null,
      ref: null,
    });
    expect(PROMOTED.AuditEvent.parse(event)).toEqual(event);
  });

  it("takes the ref from the decision's target", () => {
    expect(
      toAuditEvent({
        event: {
          ...SECURITY_EVENT,
          eventType: "capability.invoke_allowed",
          capability: "assign_agent_role",
          requestId: AGENT_DECISION.requestId,
        },
        actorPublicId: ACTOR_PUBLIC_ID,
        decision: AGENT_DECISION,
      }),
    ).toMatchObject({
      actor: { kind: "agent", agentKey: "e2erb5.defaul.rbac-mtxbbpju" },
      ref: "agt_9bn4fpe5th01qem8478m3z",
    });
  });
});

describe("toIncident", () => {
  it("maps a resolved collector incident and records no title or detail", () => {
    const incident = toIncident(INCIDENT);
    expect(incident).toEqual({
      id: "tin_5k2m9q4r7t1w3y6z8a0c2e",
      severity: 10,
      kind: "hooks_removed",
      title: null,
      at: "2026-09-11T08:40:00.000Z",
      detectedBy: "collector",
      agentKey: "e2eavg.defaul.release-manager",
      runIds: ["tse_3pb7whjgdscp26005pstmc"],
      scope: "mbell-mbp-16",
      detail: null,
      resolution: "Hooks restored by the operator.",
      status: "resolved",
      ownerId: null,
      dueOn: null,
      closedAt: "2026-09-11T09:02:00.000Z",
      closedBy: "prn_cv6302ky39te607290f12d",
    });
    expect(PROMOTED.Incident.parse(incident)).toEqual(incident);
  });

  it("keeps an open incident open, with no run and the agent key as its scope", () => {
    expect(
      toIncident({
        ...INCIDENT,
        resolvedAt: null,
        resolutionNote: null,
        hostname: null,
        sessionPublicId: null,
        resolvedByPublicId: null,
      }),
    ).toMatchObject({
      status: "open",
      runIds: [],
      scope: "e2eavg.defaul.release-manager",
      closedAt: null,
      closedBy: null,
      resolution: null,
    });
    expect(
      toIncident({ ...INCIDENT, hostname: null, agentKey: null }).scope,
    ).toBeNull();
  });
});

describe("toErasureRequest", () => {
  it("maps a queued user erasure: the requester is the subject", () => {
    const request = toErasureRequest(ERASURE);
    expect(request).toEqual({
      id: "preras_7w2m4q9r1t3y5z8a0c2e4g",
      subject: ACTOR_PUBLIC_ID,
      requestedAt: "2026-09-10T11:00:00.000Z",
      requestedById: ACTOR_PUBLIC_ID,
      status: "pending",
      effectiveAt: null,
      dueAt: "2026-10-10T11:00:00.000Z",
      scope: "user",
      holdId: null,
      note: null,
    });
    expect(ErasureRequest.parse(request)).toEqual(request);
  });

  it("names the organization as the subject of an org erasure", () => {
    expect(toErasureRequest({ ...ERASURE, scope: "org" }).subject).toBe(
      "org_2g4q6s8u0w2y4a6c8e0g2i",
    );
  });

  it("never reads a hard delete as destroyed keys", () => {
    expect(toErasureRequest({ ...ERASURE, status: "processing" }).status).toBe(
      "pending",
    );
    for (const status of ["completed", "failed"] as const)
      expect(
        toErasureRequest({
          ...ERASURE,
          status,
          completedAt: new Date("2026-10-10T11:05:00.000Z"),
          errorMessage: status === "failed" ? "blob delete timed out" : null,
        }),
      ).toMatchObject({
        status: null,
        effectiveAt: "2026-10-10T11:05:00.000Z",
      });
  });
});

describe("toArchiveExport", () => {
  it("maps a ready export and records no range, size, signature or keys", () => {
    const bundle = toArchiveExport(EXPORT);
    expect(bundle).toEqual({
      id: "prexp_4k6m8p0r2t4v6x8z0b2d4f",
      description: null,
      from: null,
      to: null,
      contents: null,
      size: null,
      createdAt: "2026-09-09T15:30:00.000Z",
      createdById: ACTOR_PUBLIC_ID,
      status: "ready",
      signature: null,
      keys: null,
    });
    expect(PROMOTED.ArchiveExport.parse(bundle)).toEqual(bundle);
  });

  it.each([
    ["queued", "building"],
    ["processing", "building"],
    ["ready", "ready"],
    ["failed", null],
  ] as const)("reads status %s as %s", (status, expected) => {
    expect(toArchiveExport({ ...EXPORT, status }).status).toBe(expected);
  });
});

describe("toRetentionTiers", () => {
  it("reports the exact-payload window as the bodies tier", () => {
    const tiers = toRetentionTiers(POSTURE);
    expect(tiers).toEqual([
      {
        tier: "bodies",
        store: null,
        contents: null,
        retention: "P400D",
        volume: null,
      },
    ]);
    expect(z.array(PROMOTED.RetentionTier).parse(tiers)).toEqual(tiers);
  });

  it.each([0, 12.5])(
    "never reads a measured overage of %s GB as the tier's volume",
    (storedGbBeyondIncluded) => {
      const [tier] = toRetentionTiers({
        ...POSTURE,
        storedGbBeyondIncluded,
        storedGbMeasured: true,
      });
      expect(tier?.volume).toBeNull();
    },
  );

  it("says nothing about a window or a volume nobody declared or measured", () => {
    expect(
      toRetentionTiers({
        ...POSTURE,
        effectiveRetentionDays: null,
        storedGbBeyondIncluded: 3,
        storedGbMeasured: false,
      }),
    ).toEqual([
      {
        tier: "bodies",
        store: null,
        contents: null,
        retention: null,
        volume: null,
      },
    ]);
  });
});

describe("toNotification", () => {
  it("maps an approval notification and finds its run in the deep link", () => {
    const n = toNotification(NOTIFICATION);
    expect(n).toEqual({
      id: "ntf_1b3d5f7h9k1m3p5r7t9v1x",
      kind: "approval",
      severity: null,
      unread: true,
      at: "2026-09-11T09:14:02.000Z",
      title: "release-manager is waiting on an approval",
      body: "github__create_release@2 needs a decision.",
      runId: "run_01K5RS8Q2M",
      ref: "/acme/core-platform/runs/run_01K5RS8Q2M/approvals",
    });
    expect(Notification.parse(n)).toEqual(n);
  });

  it.each([
    // An approval row does not say requested, approved, denied or expired.
    ["approval", null],
    ["security", "critical"],
    ["run", null],
    ["member", null],
    ["system", null],
  ] as const)(
    "draws kind %s at severity %s, never a guessed one",
    (kind, severity) => {
      const n = toNotification({ ...NOTIFICATION, kind });
      expect(n.severity).toBe(severity);
      expect(Notification.parse(n)).toEqual(n);
    },
  );

  it.each([
    ["run_01K5RS8Q2M", "run_01K5RS8Q2M"],
    ["/a/b/runs/run_01K5RS8Q2M?frame=3", "run_01K5RS8Q2M"],
    ["/a/b/runs/run_01K5RS8Q2M#chain", "run_01K5RS8Q2M"],
    ["/a/b/xrun_01K5RS8Q2M", null],
    ["/a/b/runs/run_01K5-RS8", null],
    ["/settings/mcp", null],
    [null, null],
  ] as const)("reads the run in %s as %s", (deepLink, runId) => {
    expect(toNotification({ ...NOTIFICATION, deepLink }).runId).toBe(runId);
  });

  it("keeps a missing body null", () => {
    expect(toNotification({ ...NOTIFICATION, body: null }).body).toBeNull();
  });
});

describe("rejectedPaths", () => {
  it("is empty for a sample the schema accepts and names each refused field once", () => {
    const schema = z.array(z.object({ a: z.string(), b: z.number() }));
    expect(rejectedPaths(schema, [{ a: "x", b: 1 }])).toEqual([]);
    expect(
      rejectedPaths(schema, [
        { a: 1, b: "x" },
        { a: 2, b: 3 },
      ]),
    ).toEqual(["a", "b"]);
  });
});

describe("recorded probes", () => {
  it.each(Object.keys(CURRENT) as Array<keyof typeof CURRENT>)(
    "%s: today's view model refuses the least a store holds only where nothing is recorded",
    (method) => {
      const refused = rejectedPaths(
        z.array(CURRENT[method]),
        RECORDED_PROBES[method],
      );
      expect(refused.length > 0).toBe(UNRECORDED_PATHS[method].length > 0);
      for (const path of refused)
        expect(UNRECORDED_PATHS[method] as readonly string[]).toContain(path);
    },
  );

  it.each(Object.keys(CURRENT) as Array<keyof typeof CURRENT>)(
    "%s: the promoted view model accepts it whole",
    (method) => {
      expect(
        rejectedPaths(
          z.array(PROMOTED_BY_METHOD[method]),
          RECORDED_PROBES[method],
        ),
      ).toEqual([]);
    },
  );

  it("every collector incident kind the spec lacks is probed", () => {
    expect(COLLECTOR_ONLY_INCIDENT_KINDS).toEqual([
      "config_change",
      "telemetry_gap",
      "checkpoint_lapse",
      "policy_violation",
      "spoofed_event",
      "daemon_down",
      "otel_missing",
      "unknown_model_cost",
    ]);
  });
});
