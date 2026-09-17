// posture.ts — the five live figures behind the Security overview.
//
// Its own module so the numbers can be tested without loading the page, whose
// import graph reaches Better Auth and refuses to load without a configured
// environment. The page renders what this returns and derives the SOC 2 control
// states from it.
import { and, count, desc, eq, gte, isNull, or } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { logger } from "@oxagen/handlers/logger";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface Posture {
  authFailures7d: number;
  deniedInvocations7d: number;
  activeApiKeys: number;
  totalAuditEvents: number;
  lastEventAt: Date | null;
}

export const EMPTY_POSTURE: Posture = {
  authFailures7d: 0,
  deniedInvocations7d: 0,
  activeApiKeys: 0,
  totalAuditEvents: 0,
  lastEventAt: null,
};

// WHY withSystemDb AND NOT withTenantDb: every figure below is an
// organization-wide count, and the two tables it counts are scoped by
// workspace in Postgres — `security.security_events` is policy class
// `workspace_nullable` and `auth.api_keys` is `standard`
// (packages/database/src/tenant-policy.manifest.ts). Read under the org-only
// workspace sentinel, RLS admitted only the rows carrying no workspace, and it
// hides rather than refuses, so the catch at the end could not fire and the page
// published the short answer as a live one. Three figures were wrong in a way
// a reader could act on: `deniedInvocations7d` counts capability.invoke_denied,
// which the kernel emits with the request's real workspace
// (packages/oxagen/src/kernel.ts), so it read 0 while the kernel was denying
// and the tile rendered as a success; `activeApiKeys` counted only keys
// carrying the nil sentinel; and `totalAuditEvents` drives the SOC 2 CC7.2
// control state and its auditor-facing rationale on the page. Tenant isolation is
// enforced here explicitly instead — eq(orgId) on every query — which is the
// shape packages/handlers/src/audit.log.query.ts uses over the same table.
//
// WHICH PLANE (ADR-042, and ADR-074's Decision 2 requires this to be stated):
// shared for both tables, so the plane resolution and assertDataPlaneUsable
// that withTenantDb was doing are not guarantees this read gives up.
// `security.security_events` has one writer and it inserts through
// withSystemDb (packages/database/src/security.ts); ADR-042 §2 names `auth` as
// platform state that always lives on the shared plane. See
// apps/app_deprecated/src/lib/audit-query.ts for the full reasoning on why
// re-adding the assertion here would gate a shared-plane read on a tenant's
// Postgres binding rather than restoring a kill switch.
export async function loadPosture(orgId: string): Promise<Posture> {
  const since = new Date(Date.now() - SEVEN_DAYS_MS);
  const now = new Date();
  try {
    return await withSystemDb(async (tx) => {
      const [failures] = await tx
        .select({ c: count() })
        .from(schema.securityEvents)
        .where(
          and(
            eq(schema.securityEvents.orgId, orgId),
            eq(schema.securityEvents.eventType, "auth.sign_in_failed"),
            gte(schema.securityEvents.occurredAt, since),
          ),
        );

      const [denied] = await tx
        .select({ c: count() })
        .from(schema.securityEvents)
        .where(
          and(
            eq(schema.securityEvents.orgId, orgId),
            eq(schema.securityEvents.eventType, "capability.invoke_denied"),
            gte(schema.securityEvents.occurredAt, since),
          ),
        );

      const [total] = await tx
        .select({ c: count() })
        .from(schema.securityEvents)
        .where(eq(schema.securityEvents.orgId, orgId));

      const [latest] = await tx
        .select({ occurredAt: schema.securityEvents.occurredAt })
        .from(schema.securityEvents)
        .where(eq(schema.securityEvents.orgId, orgId))
        .orderBy(desc(schema.securityEvents.occurredAt))
        .limit(1);

      const [keys] = await tx
        .select({ c: count() })
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.orgId, orgId),
            isNull(schema.apiKeys.deletedAt),
            or(
              isNull(schema.apiKeys.expiresAt),
              gte(schema.apiKeys.expiresAt, now),
            ),
          ),
        );

      return {
        authFailures7d: failures?.c ?? 0,
        deniedInvocations7d: denied?.c ?? 0,
        activeApiKeys: keys?.c ?? 0,
        totalAuditEvents: total?.c ?? 0,
        lastEventAt: latest?.occurredAt ?? null,
      };
    });
  } catch (err) {
    // Degrade to zeroes so a DB blip does not 500 the whole security section.
    // This is the one place the page can show a figure that is not live, so it
    // MUST leave a trace: an all-zero posture that nobody logged is
    // indistinguishable from a genuinely clean org.
    logger.error(
      { err, orgId },
      "security-overview: posture query failed; rendering an empty posture",
    );
    return EMPTY_POSTURE;
  }
}
