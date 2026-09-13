// The audit adapter's store reads against a real Postgres and ClickHouse: seeds
// one incident, one erasure request and one export request into an organization
// of the local stack, reads them back through the real stores and the port
// (under the promoted view models), resolves an agent-invoked IAM decision the
// stack already holds, and removes what it wrote.
//
// Opt-in, local only: MC_LIVE_DB=1 with DATABASE_URL and CLICKHOUSE_* pointing at
// the local stack (`pnpm dev`: Postgres :5433, ClickHouse :8123). The unit suite
// and CI skip it; the mocked contract tests beside it (audit.test.ts,
// mappers/audit.test.ts) run everywhere.
//
// MC_LIVE_DB_ORG / MC_LIVE_DB_WORKSPACE / MC_LIVE_DB_USER / MC_LIVE_DB_REQUEST
// name the rows to use; the defaults are the ones the local stack's e2e seed
// left behind when this test was written.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { COLLECTOR_ONLY_INCIDENT_KINDS } from "./mappers/audit";

const enabled = process.env.MC_LIVE_DB === "1";

const ORG =
  process.env.MC_LIVE_DB_ORG ?? "b686d6a9-cf49-45b4-8206-7a57b19c047a";
const WS =
  process.env.MC_LIVE_DB_WORKSPACE ?? "394cb189-a936-446d-b5b1-186ad79bc880";
const USER =
  process.env.MC_LIVE_DB_USER ?? "b05d6f61-5bd0-43c4-a813-ed2a6803e41f";
const REQUEST =
  process.env.MC_LIVE_DB_REQUEST ?? "eebeee3d-ba11-4e31-8920-230903d8eeba";
/** An organization whose owner has security events with request ids. */
const FEED_ORG =
  process.env.MC_LIVE_DB_FEED_ORG ?? "3a961128-533e-4823-aeff-8bba8def48fc";
const FEED_OWNER =
  process.env.MC_LIVE_DB_FEED_OWNER ?? "02053fa6-022c-4322-9337-823dd5890156";

describe.runIf(enabled)(
  "live audit stores against the local stack",
  { timeout: 120_000 },
  () => {
    const tag = Date.now().toString(36);
    const ids = {
      incident: `tin_mclivedb${tag}`,
      erasure: `preras_mclivedb${tag}`,
      export: `prexp_mclivedb${tag}`,
    };
    const scope = { orgId: ORG, workspaceId: WS };
    let userPublicId = "";
    let orgPublicId = "";

    beforeAll(async () => {
      // The adapter's module graph (kernel, handlers, telemetry) is slow to load
      // cold; load it once here, under the suite's timeout.
      await import("./audit");
      const { schema, withSystemDb } = await import("@oxagen/database");
      const { eq } = await import("drizzle-orm");
      await withSystemDb(async (tx) => {
        const [user] = await tx
          .select({ publicId: schema.users.publicId })
          .from(schema.users)
          .where(eq(schema.users.id, USER));
        const [org] = await tx
          .select({ publicId: schema.organizations.publicId })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, ORG));
        if (!user || !org) throw new Error("seed user or organization missing");
        userPublicId = user.publicId;
        orgPublicId = org.publicId;
        await tx.insert(schema.tachoIncidents).values({
          publicId: ids.incident,
          orgId: ORG,
          workspaceId: WS,
          kind: "hooks_removed",
          severity: 10,
          detectedAt: new Date("2026-09-11T08:40:00.000Z"),
          detectedBy: "collector",
        });
        await tx.insert(schema.privacyErasureRequests).values({
          publicId: ids.erasure,
          userId: USER,
          orgId: ORG,
          scope: "user",
          status: "queued",
          scheduledAt: new Date("2026-10-10T11:00:00.000Z"),
        });
        await tx.insert(schema.privacyExportRequests).values({
          publicId: ids.export,
          userId: USER,
          orgId: ORG,
          scope: "org",
          status: "ready",
        });
      });
    }, 120_000);

    afterAll(async () => {
      const { schema, withSystemDb } = await import("@oxagen/database");
      const { eq } = await import("drizzle-orm");
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.tachoIncidents)
          .where(eq(schema.tachoIncidents.publicId, ids.incident));
        await tx
          .delete(schema.privacyErasureRequests)
          .where(eq(schema.privacyErasureRequests.publicId, ids.erasure));
        await tx
          .delete(schema.privacyExportRequests)
          .where(eq(schema.privacyExportRequests.publicId, ids.export));
      });
    }, 120_000);

    const promoted = () =>
      ({
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
        ErasureRequest,
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
      }) as never;

    async function port() {
      const { createLiveAudit, liveAuditStores } = await import("./audit");
      return createLiveAudit({
        stores: {
          ...liveAuditStores,
          viewerId: () => Promise.resolve(USER),
          orgRole: () => Promise.resolve("compliance"),
        },
        views: promoted(),
        report: (error) => {
          throw error;
        },
      }).audit;
    }

    it("reads the seeded incident through every workspace of the organization", async () => {
      const audit = await port();
      const read = await audit.incidents({
        orgId: ORG,
        workspaceId: "00000000-0000-0000-0000-000000000000",
      });
      expect(read.ok).toBe(true);
      const found = read.ok
        ? read.value.find((i) => i.id === ids.incident)
        : null;
      expect(found).toEqual({
        id: ids.incident,
        severity: 10,
        kind: "hooks_removed",
        title: null,
        at: "2026-09-11T08:40:00.000Z",
        detectedBy: "collector",
        agentKey: null,
        runIds: [],
        scope: null,
        detail: null,
        resolution: null,
        status: "open",
        ownerId: null,
        dueOn: null,
        closedAt: null,
        closedBy: null,
      });
    });

    it("reads the seeded erasure request under today's view model", async () => {
      const audit = await port();
      const read = await audit.erasure(scope);
      const found = read.ok
        ? read.value.find((e) => e.id === ids.erasure)
        : null;
      expect(found).toMatchObject({
        subject: userPublicId,
        requestedById: userPublicId,
        status: "pending",
        dueAt: "2026-10-10T11:00:00.000Z",
        scope: "user",
        holdId: null,
      });
      expect(orgPublicId).toMatch(/^org_/);
    });

    it("reads the seeded export request", async () => {
      const audit = await port();
      const read = await audit.exports(scope);
      const found = read.ok
        ? read.value.find((e) => e.id === ids.export)
        : null;
      expect(found).toMatchObject({
        createdById: userPublicId,
        status: "ready",
        from: null,
        signature: null,
      });
    });

    // The agent-tool reads run through the real kernel and handlers without the
    // IAM runtime (this test boots no instrumentation), so they read real rows
    // through each tool's own output schema and write no audit rows of their
    // own. The IAM denial path is covered by audit.test.ts.
    async function asOwner() {
      const { createLiveAudit, liveAuditStores } = await import("./audit");
      return createLiveAudit({
        stores: {
          ...liveAuditStores,
          viewerId: () => Promise.resolve(FEED_OWNER),
        },
        views: promoted(),
        report: (error) => {
          throw error;
        },
      });
    }
    const feedScope = {
      orgId: FEED_ORG,
      workspaceId: "00000000-0000-0000-0000-000000000000",
    };

    it("reads the organization's security events through query_audit_log", async () => {
      const { audit } = await asOwner();
      const read = await audit.events(feedScope);
      expect(read.ok).toBe(true);
      const events = read.ok ? read.value : [];
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.severity).toBeNull();
        expect(event.summary).toBeNull();
      }
      expect(
        events.some(
          (e) => (e.actor as { kind: string } | null)?.kind === "person",
        ),
      ).toBe(true);
    });

    it("reads the retention posture through get_evidence_retention", async () => {
      const { audit } = await asOwner();
      const read = await audit.retention(feedScope);
      expect(read).toMatchObject({
        ok: true,
        value: [{ tier: "bodies", store: null, contents: null }],
      });
    });

    it("reads the viewer's notifications through list_notifications", async () => {
      const { notifications } = await asOwner();
      const read = await notifications(feedScope);
      expect(read.ok).toBe(true);
    });
  },
);

// No seeding hooks here, so this suite also runs as the RLS-bound app role,
// which may read seeded rows but not delete them. The local stack's default
// role is a superuser, and RLS never applies to a superuser, so under it this
// test passes whether or not the lookup respects RLS. The proof needs the app role:
//   DATABASE_URL="<local url>?options=-c%20role%3Doxagen_app" \
//   TENANT_RLS_ENFORCEMENT_ENABLED=true MC_LIVE_DB=1 \
//   pnpm exec vitest run src/data/adapters/live/audit.db.test.ts -t "row-level security"
describe.runIf(enabled)(
  "agent actors under row-level security",
  { timeout: 120_000 },
  () => {
    beforeAll(async () => {
      await import("./audit");
    }, 120_000);

    it("resolves an agent-invoked decision in ClickHouse to the agent's key under the audit page's organization scope", async () => {
      const { liveAuditStores } = await import("./audit");
      // The audit page reads at organization scope, where RLS hides every
      // agent: the lookup must run under the workspace the event ran in.
      const rows = await liveAuditStores.decisions(
        { orgId: ORG, workspaceId: "00000000-0000-0000-0000-000000000000" },
        [
          {
            requestId: REQUEST,
            capability: "assign_agent_role",
            workspaceId: WS,
          },
        ],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        requestId: REQUEST,
        capability: "assign_agent_role",
        actingPrincipalKind: "agent",
        targetKind: "agent",
      });
      expect(rows[0]?.principal?.agentKey).toMatch(
        /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/,
      );
    });
  },
);
