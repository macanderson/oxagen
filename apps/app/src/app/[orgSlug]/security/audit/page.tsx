// Security → Audit: filterable, paginated audit-log viewer with signed export.
// See docs/architecture/security/soc2-simplification.html.
//
// URL-driven filters, keyset pagination, per-row forensic drill-down, and a
// signed NDJSON/CSV export. Export is an Enterprise feature and additionally
// requires an owner/admin role; both gates
// are re-checked in the export route (the disabled button is cosmetic).

import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { inArray } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import {
  resolveOrg,
  assertOrgMember,
  getOrgRole,
  SECURITY_MANAGER_ROLES,
} from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { getEnterpriseAccess } from "@/lib/enterprise";
import { org } from "@/lib/routes";
import { EnterpriseUpsell } from "@/components/security/enterprise-upsell";
import {
  parseAuditFilter,
  encodeAuditFilter,
  hasActiveFilter,
} from "@/lib/audit-filters";
import { queryAuditPage } from "@/lib/audit-query";
import { AuditFilterBar } from "./_components/audit-filter-bar";
import { AuditEventRow } from "./_components/audit-event-row";
import { AuditExportButtons } from "./_components/audit-export-buttons";

/** Batch-resolve actor user IDs → display names for a page of audit rows. */
async function resolveActorNames(
  userIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        id: schema.users.id,
        displayName: schema.users.displayName,
        email: schema.users.email,
      })
      .from(schema.users)
      .where(inArray(schema.users.id, unique)),
  );
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.id, r.displayName ?? r.email);
  return map;
}

export default async function SecurityAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const sp = await searchParams;

  const [session, tenant] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
  await assertOrgMember(tenant.id, session.user.id);

  const [access, role, filter] = await Promise.all([
    getEnterpriseAccess(tenant.id),
    getOrgRole(tenant.id, session.user.id),
    Promise.resolve(parseAuditFilter(sp)),
  ]);

  const page = await queryAuditPage(tenant.id, filter);

  // Batch-resolve actor names so rows show "Alice Smith" instead of raw UUIDs.
  const actorIds = page.rows
    .map((e) => e.actorUserId)
    .filter((id): id is string => id !== null);
  const actorNames = await resolveActorNames(actorIds);

  const isManager = role != null && SECURITY_MANAGER_ROLES.has(role);
  const canExport = access.isEnterprise && isManager;
  const disabledReason = !access.isEnterprise
    ? "Signed audit export requires the Enterprise plan."
    : "Signed audit export requires an owner or admin role.";

  // Pagination links (keyset → forward + first-page).
  const onFirstPage = filter.cursor === null;
  const nextHref = page.nextCursor
    ? `${org.security.audit({ orgSlug })}?${encodeAuditFilter(filter, { cursor: page.nextCursor }).toString()}`
    : null;
  const firstHref = `${org.security.audit({ orgSlug })}?${encodeAuditFilter(filter, { cursor: null }).toString()}`;

  return (
    <div className="flex flex-col gap-6">
      {!access.isEnterprise && (
        <EnterpriseUpsell
          orgSlug={orgSlug}
          feature="Audit log export"
          currentTier={access.tier}
        />
      )}

      <Panel
        title="Audit log"
        actions={
          <AuditExportButtons
            canExport={canExport}
            disabledReason={disabledReason}
          />
        }
      >
        <div className="flex flex-col gap-4">
          <p className="mb-4 text-sm text-muted-foreground">
            Append-only security event stream. Filter, drill down, and export
            signed evidence.
          </p>
          <AuditFilterBar
            selectedEventTypes={filter.eventTypes}
            selectedOutcome={filter.outcome}
            q={filter.q}
            from={filter.from ? filter.from.toISOString() : null}
            to={filter.to ? filter.to.toISOString() : null}
          />

          {page.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {hasActiveFilter(filter)
                ? "No security events match these filters."
                : "No security events recorded yet."}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {page.rows.map((e) => (
                <AuditEventRow
                  key={e.id}
                  row={{
                    id: e.id,
                    occurredAt: e.occurredAt.toISOString(),
                    eventType: e.eventType,
                    outcome: e.outcome,
                    actorUserId: e.actorUserId,
                    actorName: e.actorUserId
                      ? (actorNames.get(e.actorUserId) ?? null)
                      : null,
                    workspaceId: e.workspaceId,
                    capability: e.capability,
                    ip: e.ip,
                    userAgent: e.userAgent,
                    requestId: e.requestId,
                  }}
                />
              ))}
            </div>
          )}

          {/* Keyset pagination: forward + jump-to-first. */}
          {(nextHref || !onFirstPage) && (
            <div className="flex items-center justify-between pt-1">
              {!onFirstPage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  render={<Link href={firstHref} />}
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  First page
                </Button>
              ) : (
                <span />
              )}
              {nextHref ? (
                <Button
                  variant="outline"
                  size="sm"
                  render={<Link href={nextHref} />}
                >
                  Next
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  End of results
                </span>
              )}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
