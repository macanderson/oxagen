/**
 * Policies — the human-readable face of the permitted-action link.
 *
 * Three sections:
 *  - IAM roles & grants (list_iam_roles) — READ-ONLY by design: role/grant
 *    writes remain provisioning-script-only until the IAM write contracts are
 *    authored (ship-read-first; the gap is flagged inline, never faked).
 *  - Entitlement gates — derived from the capability registry: which
 *    capabilities sit behind a capability-pack, the pack tier, and whether
 *    the org's plan satisfies the pack's minimum tier.
 *  - MCP auth alerts (get_auth_alerts / set_auth_alerts) — the one editable
 *    policy on this page today.
 *
 * Roles/entitlements read failures degrade section-level with a banner (the
 * spec's read-only-first posture); the alerts panel gates writes to admins.
 */

import Link from "next/link";
import type { CapabilityRegistryListOutput } from "@oxagen/oxagen/contracts/capability.registry.list";
import type { IamRoleListOutput } from "@oxagen/oxagen/contracts/iam.role.list";
import type { PluginSettingsGetAuthAlertsOutput } from "@oxagen/oxagen/contracts/plugin.settings.get_auth_alerts";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  assertOrgMember,
  getOrgRole,
  SECURITY_MANAGER_ROLES,
} from "@/lib/resolve-org";
import { getEnterpriseAccess } from "@/lib/enterprise";
import { org as orgRoutes } from "@/lib/routes";
import { logger } from "@oxagen/handlers/logger";
import { invokeOrgCapability } from "../_lib/invoke-org";
import { deriveEntitlementRows } from "./entitlements";
import { AuthAlertsPanel } from "./_components/auth-alerts-panel";

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
      "governance/policies: read failed",
    );
    return null;
  }
}

export default async function PoliciesPage({
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

  const [roles, registry, alerts, access, viewerRole] = await Promise.all([
    safeInvoke<IamRoleListOutput>(tenant.id, userId, "list_iam_roles", {
      includeGrants: true,
      limit: 100,
      offset: 0,
    }),
    safeInvoke<CapabilityRegistryListOutput>(
      tenant.id,
      userId,
      "list_capability_registry",
      {
        limit: 1000,
        offset: 0,
      },
    ),
    safeInvoke<PluginSettingsGetAuthAlertsOutput>(
      tenant.id,
      userId,
      "get_auth_alerts",
      {},
    ),
    getEnterpriseAccess(tenant.id),
    getOrgRole(tenant.id, userId),
  ]);

  const canEditAlerts =
    viewerRole != null && SECURITY_MANAGER_ROLES.has(viewerRole);
  const entitlements = registry
    ? deriveEntitlementRows(registry.capabilities, access.tier)
    : null;

  const ctx = { orgSlug };

  return (
    <div className="flex flex-col gap-6" data-testid="governance-policies">
      {/* Roles & permissions (read-only) */}
      <Panel
        title="Roles & permissions"
        actions={
          <Badge size="sm" variant="muted">
            read-only
          </Badge>
        }
      >
        {roles === null ? (
          <p className="text-sm text-muted-foreground" role="alert">
            Unable to load IAM roles right now. Reload to try again.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Roles and their capability grants are provisioned automatically
              from each contract&apos;s defaults. Editing roles in the app ships
              with the IAM write contracts — until then this view is read-only.
            </p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table
                className="w-full text-left text-sm"
                data-testid="roles-table"
              >
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Scope</th>
                    <th className="px-3 py-2 font-medium">Members</th>
                    <th className="px-3 py-2 font-medium">Grants</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.roles.map((role) => {
                    const allow = role.grants.filter(
                      (g) => g.effect === "allow",
                    ).length;
                    const deny = role.grants.filter(
                      (g) => g.effect === "deny",
                    ).length;
                    const approval = role.grants.filter(
                      (g) => g.effect === "require_approval",
                    ).length;
                    return (
                      <tr
                        key={role.id}
                        className="border-b border-border align-top last:border-b-0"
                      >
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground">
                              {role.name}
                            </span>
                            {role.isSystemDefault ? (
                              <Badge size="sm" variant="muted">
                                system
                              </Badge>
                            ) : null}
                          </div>
                          {role.description ? (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {role.description}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {role.scopeKind}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {role.memberCount}
                        </td>
                        <td className="px-3 py-2">
                          {role.grants.length === 0 ? (
                            <span className="text-xs text-muted-foreground">
                              No default grants
                            </span>
                          ) : (
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground">
                                {allow} allow
                                {approval > 0 ? ` · ${approval} approval` : ""}
                                {deny > 0 ? ` · ${deny} deny` : ""}
                              </summary>
                              <div className="mt-1.5 flex max-w-xl flex-wrap gap-1">
                                {role.grants.map((g) => (
                                  <Badge
                                    key={g.capability}
                                    size="sm"
                                    variant={
                                      g.effect === "allow"
                                        ? "success-soft"
                                        : g.effect === "require_approval"
                                          ? "warning-soft"
                                          : "error-soft"
                                    }
                                  >
                                    {g.capability}
                                  </Badge>
                                ))}
                              </div>
                            </details>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>

      {/* Entitlement gates */}
      <Panel
        title="Entitlements"
        actions={
          <Badge size="sm" variant="muted">
            plan: {access.tier}
          </Badge>
        }
      >
        {entitlements === null ? (
          <p className="text-sm text-muted-foreground" role="alert">
            Unable to load the capability registry, so entitlement gates
            can&apos;t be shown right now.
          </p>
        ) : entitlements.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No entitlement gates configured — no capability in the registry is
            behind a capability pack.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              These capabilities are gated behind a capability pack: the pack
              must be installed in the invoking workspace, and packs with a
              minimum plan tier also require the org plan to meet it.
            </p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table
                className="w-full text-left text-sm"
                data-testid="entitlements-table"
              >
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-3 py-2 font-medium">Capability</th>
                    <th className="px-3 py-2 font-medium">Pack</th>
                    <th className="px-3 py-2 font-medium">Pack tier</th>
                    <th className="px-3 py-2 font-medium">Min plan</th>
                    <th className="px-3 py-2 font-medium">Plan gate</th>
                  </tr>
                </thead>
                <tbody>
                  {entitlements.map((row) => (
                    <tr
                      key={row.capability}
                      className="border-b border-border last:border-b-0"
                    >
                      <td className="px-3 py-2 font-mono text-xs">
                        {row.capability}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {row.packId}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          size="sm"
                          variant={
                            row.packTier === "premium"
                              ? "warning-soft"
                              : "muted"
                          }
                        >
                          {row.packTier}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {row.minPlanTier ?? "any"}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          size="sm"
                          variant={
                            row.planSatisfied ? "success-soft" : "error-soft"
                          }
                        >
                          {row.planSatisfied ? "allowed" : "blocked"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>

      {/* MCP auth alerts */}
      <Panel title="MCP auth alerts">
        {alerts === null ? (
          <p className="text-sm text-muted-foreground" role="alert">
            Unable to load the alert setting right now.
          </p>
        ) : (
          <AuthAlertsPanel
            orgSlug={orgSlug}
            initialSendEmail={alerts.sendEmail}
            initialRoles={alerts.roles}
            isDefault={alerts.isDefault}
            canEdit={canEditAlerts}
          />
        )}
      </Panel>

      {/* Cross-links */}
      <p className="text-xs text-muted-foreground">
        Related policies:{" "}
        <Link className="underline" href={orgRoutes.security.mfa(ctx)}>
          org MFA policy
        </Link>{" "}
        (Security → MFA) · workspace budget policies live in each
        workspace&apos;s settings (commercial terms are governed per-workspace).
      </p>
    </div>
  );
}
