/**
 * Security → MFA Policy: org-wide MFA enforcement configuration.
 *
 * Reads the current org security policy from security.org_security_policy.
 * Owner/admin can toggle require-MFA + set grace period.
 * Emits security.mfa_policy_updated on save (CC6.1 / CC6.2 evidence).
 */

import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import {
  resolveOrg,
  getOrgRole,
  SECURITY_MANAGER_ROLES,
} from "@/lib/resolve-org";
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
      <Panel
        title="MFA policy"
        actions={
          <Badge
            variant={mfaRequired ? "success" : "muted"}
            className="shrink-0 text-xs"
          >
            {mfaRequired ? "Enforced" : "Not enforced"}
          </Badge>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Require multi-factor authentication for every member in this
          organization. Satisfies SOC 2 CC6.1 logical access controls and CC6.2
          authentication requirements.
        </p>
        <MfaPolicyForm
          orgSlug={orgSlug}
          canEdit={canEdit}
          initialMfaRequired={mfaRequired}
          initialMfaGraceHours={mfaGraceHours}
        />
      </Panel>

      {/* Evidence note */}
      <Panel title="Audit evidence">
        Every policy change is recorded as a{" "}
        <code className="text-xs font-mono bg-muted px-1 rounded">
          security.mfa_policy_updated
        </code>{" "}
        event in the append-only audit log with actor, timestamp, and outcome —
        satisfying CC6.1 and CC6.2 change evidence requirements.
      </Panel>
    </div>
  );
}
