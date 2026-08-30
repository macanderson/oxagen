// auth.session-expiry-audit.ts — hourly cron that emits auth.sign_out security
// events for sessions that expired by TTL (30-day window).
//
// SOC 2 CC6.1/CC7.2 gap (OXA-1422): Better Auth's session.delete.after hook
// only fires on explicit sign-outs. Sessions that expire by TTL are never
// caught, leaving a silent gap in the access audit trail.
//
// Design:
//   - Runs every hour; scans a 25-hour sliding window to tolerate one missed run.
//   - Dedup key: requestId = 'ttl:' + session.id. A LEFT JOIN on security_events
//     filters out sessions already processed — no separate tracking table needed.
//   - Batch cap of 500 per run; logs a WARN if the limit is hit so ops can
//     investigate backfill need.
//   - Org resolution: same first-org-membership strategy as auth.ts (OXA-1422
//     follow-up: add org_id to sessions so this is exact).
//   - All DB access is via withSystemDb (identity resolution before tenant scope,
//     consistent with OXA-1515 tenancy analysis in packages/telemetry/src/security.ts).

import { and, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { createFunction } from "../create-function";
import { schema, withSystemDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { logger } from "../logger";

const NO_ORG_SENTINEL = "00000000-0000-0000-0000-000000000000";
const BATCH_SIZE = 500;
const WINDOW_HOURS = 25;

export const [authSessionExpiryAudit] = createFunction(
  {
    id: "auth/session-expiry-audit",
    retries: 3,
    // One instance at a time to prevent double-emit races during concurrent runs.
    concurrency: { limit: 1 },
  },
  { cron: "0 * * * *" },
  async ({ step }) => {
    // ── Step 1: find expired sessions without a TTL sign_out event ──────────
    const sessions = await step.run("find-expired-sessions", async () => {
      const now = new Date();
      const windowStart = new Date(
        now.getTime() - WINDOW_HOURS * 60 * 60 * 1000,
      );

      return withSystemDb((tx) =>
        // LEFT JOIN on security_events using the 'ttl:<sessionId>' dedup key.
        // Rows where se.id IS NULL have never had a TTL sign_out emitted.
        tx
          .select({
            sessionId: schema.sessions.id,
            userId: schema.sessions.userId,
            expiresAt: schema.sessions.expiresAt,
            ipAddress: schema.sessions.ipAddress,
            userAgent: schema.sessions.userAgent,
          })
          .from(schema.sessions)
          .leftJoin(
            schema.securityEvents,
            sql`${schema.securityEvents.requestId} = 'ttl:' || ${schema.sessions.id}
              AND ${schema.securityEvents.eventType} = 'auth.sign_out'`,
          )
          .where(
            and(
              lt(schema.sessions.expiresAt, now),
              gt(schema.sessions.expiresAt, windowStart),
              isNull(schema.securityEvents.id),
            ),
          )
          .limit(BATCH_SIZE),
      );
    });

    if (sessions.length === 0) {
      logger.info("auth.session-expiry-audit: no unprocessed expired sessions");
      return { emitted: 0 };
    }

    if (sessions.length === BATCH_SIZE) {
      logger.warn(
        { batchSize: BATCH_SIZE, windowHours: WINDOW_HOURS },
        "auth.session-expiry-audit: hit batch cap — additional sessions may remain; will be processed next run",
      );
    }

    // ── Step 2: batch-resolve org memberships for unique users ──────────────
    const orgMap = await step.run("resolve-org-memberships", async () => {
      const userIds = [...new Set(sessions.map((s) => s.userId))];
      const map: Record<string, string> = {};

      await withSystemDb(async (tx) => {
        const rows = await tx
          .select({
            userId: schema.orgUsers.userId,
            orgId: schema.orgUsers.orgId,
          })
          .from(schema.orgUsers)
          .where(inArray(schema.orgUsers.userId, userIds))
          .orderBy(schema.orgUsers.joinedAt);

        // Keep the first (oldest) org per user — matches resolveFirstOrgId in auth.ts.
        for (const row of rows) {
          if (!map[row.userId]) {
            map[row.userId] = row.orgId;
          }
        }
      });

      return map;
    });

    // ── Step 3: emit auth.sign_out for each expired session ─────────────────
    const emitted = await step.run("emit-sign-out-events", async () => {
      let count = 0;
      for (const session of sessions) {
        // expiresAt arrives as a Date from the DB query but as an ISO string
        // after Inngest serializes and deserializes step output via JSON.
        const raw = session.expiresAt as unknown;
        const occurredAt =
          typeof raw === "string" ? new Date(raw) : (raw as Date);

        await emitSecurityEventAsync({
          eventType: "auth.sign_out",
          actorUserId: session.userId,
          orgId: orgMap[session.userId] ?? NO_ORG_SENTINEL,
          workspaceId: null,
          capability: null,
          outcome: "success",
          occurredAt,
          ip: session.ipAddress ?? null,
          userAgent: session.userAgent ?? null,
          requestId: `ttl:${session.sessionId}`,
        });
        count++;
      }
      return count;
    });

    logger.info(
      { emitted, total: sessions.length },
      "auth.session-expiry-audit complete",
    );

    return { emitted };
  },
);
