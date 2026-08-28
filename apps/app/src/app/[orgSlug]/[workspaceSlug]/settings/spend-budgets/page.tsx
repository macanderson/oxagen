/**
 * page.tsx — Workspace → Settings → Spend Budgets.
 *
 * Workspace-scoped (real workspaceId, not the org-level billing/* sentinel)
 * so getScopeBudgets' RLS narrowing returns BOTH the org-level ceiling and
 * this workspace's own ceiling in one read — see ./actions.ts for the full
 * placement rationale.
 */
import type { Metadata } from "next";
import { AlertTriangle, Wallet } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
  getOrgRole,
  BILLING_MANAGER_ROLES,
} from "@/lib/resolve-org";
import { getSpendBudgetsAction } from "./actions";
import { SpendBudgetsPanel } from "./spend-budgets-panel";

export const metadata: Metadata = {
  title: "Spend Budgets — Workspace Settings",
};

export default async function SpendBudgetsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;

  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  await resolveWorkspace(org.id, workspaceSlug);
  // Membership gate for page access (404 for non-members, consistent with
  // every other settings page). The actual authorization boundary lives in
  // actions.ts: getSpendBudgetsAction reads at Member level (mirroring
  // get_spend_budget's own `defaultRoles`), setSpendBudgetAction writes at
  // billing-manager level. `canManage` below is UI-gating only (hide/disable
  // the edit controls for a Member) — the real enforcement is re-checked
  // server-side by setSpendBudgetAction on every write regardless of what the
  // client renders.
  await assertOrgMember(org.id, session.user.id);

  const [result, role] = await Promise.all([
    getSpendBudgetsAction(orgSlug, workspaceSlug),
    getOrgRole(org.id, session.user.id),
  ]);
  // getOrgRole + BILLING_MANAGER_ROLES (not a hand-rolled duplicate list) —
  // same pattern as security/audit/page.tsx's `isManager`, reusing the
  // exported constant resolve-org.ts already keeps in sync with
  // assertBillingManager rather than re-deriving the role list here.
  const canManage = role !== null && BILLING_MANAGER_ROLES.has(role);

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div className="flex items-start gap-3">
        <Wallet
          className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-semibold text-foreground">Spend budgets</p>
          <p className="text-xs text-muted-foreground">
            Hard period-to-date spend ceilings. The organization ceiling covers
            every workspace; the workspace ceiling covers this workspace only.
            Once a ceiling is exceeded, agent runs against that scope are denied
            until the ceiling is raised or the period rolls over.
          </p>
        </div>
      </div>

      {result.ok ? (
        <SpendBudgetsPanel
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialBudgets={result.budgets}
          canManage={canManage}
        />
      ) : (
        <Alert variant="error" data-testid="spend-budgets-error">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Can&apos;t load spend budgets</AlertTitle>
          <AlertDescription>{result.error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
