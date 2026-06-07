/**
 * Security → MFA Policy: org-wide MFA enforcement configuration.
 *
 * Reads the current org security policy from security.org_security_policy.
 * Owner/admin can toggle require-MFA + set grace period.
 * Emits security.mfa_policy_updated on save (CC6.1 / CC6.2 evidence).
 */

import { ShieldCheck } from "lucide-react";
import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { resolveOrg, getOrgRole, SECURITY_MANAGER_ROLES } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { loadMfaPolicy } from "./actions";
import { MfaPolicyForm } from "./_components/mfa-policy-form";

export default async function SecurityMfaPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [session, tenant] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);

  const [policy, role] = await Promise.all([
    loadMfaPolicy(tenant.id),
    getOrgRole(tenant.id, session.user.id),
  ]);

  const canEdit = role != null && SECURITY_MANAGER_ROLES.has(role);
  const mfaRequired = policy?.mfaRequired ?? false;
  const mfaGraceHours = policy?.mfaGraceHours ?? 48;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </span>
              <div>
                <CardTitle>MFA Policy</CardTitle>
                <CardDescription>
                  Require multi-factor authentication for every member in this
                  organization. Satisfies SOC 2 CC6.1 logical access controls and
                  CC6.2 authentication requirements.
                </CardDescription>
              </div>
            </div>
            <Badge
              variant={mfaRequired ? "success" : "muted"}
              className="shrink-0 text-xs"
            >
              {mfaRequired ? "Enforced" : "Not enforced"}
            </Badge>
          </div>
        </CardHeader>
        <CardPanel>
          <MfaPolicyForm
            orgSlug={orgSlug}
            canEdit={canEdit}
            initialMfaRequired={mfaRequired}
            initialMfaGraceHours={mfaGraceHours}
          />
        </CardPanel>
      </Card>

      {/* Evidence note */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Audit evidence</CardTitle>
          <CardDescription>
            Every policy change is recorded as a{" "}
            <code className="text-xs font-mono bg-muted px-1 rounded">
              security.mfa_policy_updated
            </code>{" "}
            event in the append-only audit log with actor, timestamp, and outcome —
            satisfying CC6.1 and CC6.2 change evidence requirements.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
