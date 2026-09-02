/**
 * Governance hub — the six links of the accountability chain as a board.
 *
 * Every capability invocation in Oxagen is one enforced object binding
 * identity → knowledge scope → permitted action → commercial terms →
 * verified outcome → audit record. This hub renders each link as a card with
 * a live metric (grounded in the capability registry, IAM roles, and audit
 * spine reads — all through invoke()) and a deep link into the dedicated
 * surface. Each data source degrades card-level ("Unable to load") so one
 * failing read never blanks the board.
 *
 * apps/app does not bootstrap kernel IAM — the page gates explicitly
 * (assertOrgMember) before any invoke, mirroring the audit-page precedent.
 */

import {
  Users,
  Network,
  ShieldCheck,
  Coins,
  BadgeCheck,
  ScrollText,
} from "lucide-react";
import { inArray } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import type {
  AuditLogQueryOutput,
  AuditEvent,
} from "@oxagen/oxagen/contracts/audit.log.query";
import type { CapabilityRegistryListOutput } from "@oxagen/oxagen/contracts/capability.registry.list";
import type { IamRoleListOutput } from "@oxagen/oxagen/contracts/iam.role.list";
import { Tile } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { Panel } from "@/components/ui/panel";
import { Stat, StatGroup } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { org } from "@/lib/routes";
import { logger } from "@oxagen/handlers/logger";
import { invokeOrgCapability } from "./_lib/invoke-org";
import { computeChainMetrics, formatCappedCount } from "./_lib/hub-metrics";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve actor user ids → display names for the denied feed (audit-page
 * pattern). Best-effort: a failed lookup degrades to "Unknown actor" rows
 * rather than blanking the board, matching every other read on this page.
 */
async function resolveActorNames(
  userIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  try {
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
    for (const r of rows) map.set(r.id, r.displayName ?? r.email);
  } catch (err) {
    logger.warn({ err }, "governance/hub: actor name resolve failed");
  }
  return map;
}

async function safeInvoke<T>(
  orgId: string,
  userId: string,
  name: string,
  input: unknown,
): Promise<T | null> {
  try {
    return await invokeOrgCapability<T>(orgId, userId, name, input);
  } catch (err) {
    logger.error(
      { err, orgId, capability: name },
      "governance/hub: read failed",
    );
    return null;
  }
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default async function GovernancePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [session, tenant] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
  await assertOrgMember(tenant.id, session.user.id);
  const userId = session.user.id;

  const now = new Date().getTime();
  const from7d = new Date(now - 7 * DAY_MS).toISOString();
  const from30d = new Date(now - 30 * DAY_MS).toISOString();

  const [registry, roles, denied, recent] = await Promise.all([
    safeInvoke<CapabilityRegistryListOutput>(
      tenant.id,
      userId,
      "list_capability_registry",
      {
        limit: 1000,
        offset: 0,
      },
    ),
    safeInvoke<IamRoleListOutput>(tenant.id, userId, "list_iam_roles", {
      includeGrants: false,
      limit: 200,
      offset: 0,
    }),
    safeInvoke<AuditLogQueryOutput>(tenant.id, userId, "query_audit_log", {
      source: "security",
      outcome: "deny",
      from: from30d,
      limit: 10,
      offset: 0,
    }),
    safeInvoke<AuditLogQueryOutput>(tenant.id, userId, "query_audit_log", {
      source: "all",
      from: from7d,
      limit: 200,
      offset: 0,
    }),
  ]);

  const metrics = registry ? computeChainMetrics(registry.capabilities) : null;
  const assignments = roles
    ? roles.roles.reduce((sum, r) => sum + r.memberCount, 0)
    : null;

  const deniedEvents: AuditEvent[] = denied?.events ?? [];
  const actorNames = await resolveActorNames(
    deniedEvents
      .map((e) => e.actorUserId)
      .filter((id): id is string => id !== null),
  );

  const ctx = { orgSlug };
  const unavailable = "Unable to load";

  const cards = [
    {
      icon: Users,
      title: "Identity",
      description: "Who is acting — members, agents, and the roles they hold.",
      metric: roles
        ? `${roles.total} roles · ${assignments} active assignments`
        : unavailable,
      href: org.members(ctx),
      linkLabel: "Open People",
    },
    {
      icon: Network,
      title: "Knowledge scope",
      description:
        "What each capability may touch — tenant-scope enforcement on every invocation.",
      metric: metrics
        ? `${metrics.scoped} of ${metrics.totalContracts} contracts tenant-scoped`
        : unavailable,
      href: `/${orgSlug}`,
      linkLabel: "Open workspace knowledge",
    },
    {
      icon: ShieldCheck,
      title: "Permitted action",
      description:
        "The typed contract catalog — every action is a governed, IAM-gated object.",
      metric: metrics
        ? `${metrics.totalContracts} contracts · ${metrics.appCovered} human-operable`
        : unavailable,
      href: org.governance.capabilities(ctx),
      linkLabel: "Open Capabilities",
    },
    {
      icon: Coins,
      title: "Commercial terms",
      description:
        "Metering on every invocation — the observed-usage → billing loop.",
      metric: metrics
        ? `${metrics.billingGated} billing-gated · ${metrics.entitlementGated} pack-entitled`
        : unavailable,
      href: org.billing.usage(ctx),
      linkLabel: "Open Usage & Metering",
    },
    {
      icon: BadgeCheck,
      title: "Verified outcome",
      description:
        "Contracts carrying verification evidence (unit + e2e layers).",
      metric: metrics
        ? `${metrics.e2eVerified} e2e-verified · ${metrics.unitVerified} unit-verified`
        : unavailable,
      href: `${org.governance.capabilities(ctx)}?missingLayer=e2e`,
      linkLabel: "View verification gaps",
    },
    {
      icon: ScrollText,
      title: "Audit record",
      description:
        "The immutable trail every governed invocation leaves behind.",
      metric: recent
        ? `${formatCappedCount(recent.events.length, recent.hasMore)} events (7d)`
        : unavailable,
      href: org.security.audit(ctx),
      linkLabel: "Open Audit log",
    },
  ];

  return (
    <div className="flex flex-col gap-6" data-testid="governance-hub">
      {/* Summary tiles */}
      <StatGroup columns={3}>
        <Stat
          label="Active contracts"
          value={metrics ? String(metrics.totalContracts) : "—"}
          hint="typed capability contracts in the registry"
        />
        <Stat
          label="Audit events"
          value={
            recent
              ? formatCappedCount(recent.events.length, recent.hasMore)
              : "—"
          }
          hint="security + automation events, last 7 days"
        />
        <Stat
          label="Denied invocations"
          value={
            denied
              ? formatCappedCount(deniedEvents.length, denied.hasMore)
              : "—"
          }
          hint="permitted-action denials, last 30 days"
        />
      </StatGroup>

      {/* The six links of the accountability chain */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <Tile
            key={card.title}
            icon={card.icon}
            title={card.title}
            description={card.description}
            href={card.href}
            footer={
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {card.metric}
                </span>
                <span className="text-xs font-medium text-foreground">
                  {card.linkLabel} →
                </span>
              </div>
            }
          />
        ))}
      </div>

      {/* Recent denied invocations */}
      <Panel title="Recent denied invocations">
        {denied === null ? (
          <p className="text-sm text-muted-foreground">
            Unable to load the denied-invocation feed. Open the{" "}
            <a className="underline" href={org.security.audit(ctx)}>
              audit log
            </a>{" "}
            to investigate directly.
          </p>
        ) : deniedEvents.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="denied-all-clear"
          >
            No denied invocations in the last 30 days — all clear.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="denied-feed">
            {deniedEvents.map((e, i) => (
              <li
                key={`${e.occurredAt}-${i}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2"
              >
                <Badge variant="error-soft" size="sm">
                  deny
                </Badge>
                <span className="font-mono text-xs text-foreground">
                  {e.capability ?? e.eventType}
                </span>
                <span className="text-xs text-muted-foreground">
                  {e.actorUserId
                    ? (actorNames.get(e.actorUserId) ?? "Unknown actor")
                    : "System"}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {formatWhen(e.occurredAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
