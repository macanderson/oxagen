/**
 * page.tsx — Workspace → Settings → Budget (OXA-2081, live-wired).
 *
 * Server component: reads the workspace's governed per-turn budget via the
 * `workspace.budget.policy.read` capability and the caller's workspace role,
 * then renders the editable <WorkspaceBudgetForm>. Writes go through
 * updateWorkspaceBudgetAction → `workspace.budget.policy.write`
 * (Owner/Admin-gated — see budget-action.ts).
 */
import type { Metadata } from "next";
import { Wallet } from "lucide-react";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind foundation handlers into the kernel so
// invoke("get_budget_policy", …) resolves its handler.
import "@oxagen/handlers/register";
import type { WorkspaceBudgetPolicyReadOutput } from "@oxagen/oxagen/contracts/workspace.budget_policy.read";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { WorkspaceBudgetForm } from "./budget-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Budget — Workspace Settings",
};

const EDITOR_ROLES = new Set(["owner", "admin"]);

export default async function WorkspaceBudgetPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const { policy, canEdit } = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    async () => {
      // Read the caller's workspace role server-side for the canEdit
      // affordance (the write action re-checks this — never trust a client flag).
      const roleRows = await withTenantDb((tx) =>
        tx
          .select({ role: schema.workspaceUsers.role })
          .from(schema.workspaceUsers)
          .where(
            and(
              eq(schema.workspaceUsers.workspaceId, ws.id),
              eq(schema.workspaceUsers.userId, session.user.id),
            ),
          )
          .limit(1),
      );
      const role = (roleRows[0]?.role ?? "").toLowerCase();

      const read = (await invoke(
        "get_budget_policy",
        {},
        {
          orgId: org.id,
          workspaceId: ws.id,
          userId: session.user.id,
          apiKeyId: null,
          requestId: crypto.randomUUID(),
          surface: "app" as const,
          messageId: null,
        },
        { surface: "agent" },
      )) as WorkspaceBudgetPolicyReadOutput;

      return { policy: read, canEdit: EDITOR_ROLES.has(role) };
    },
  );

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <div className="flex items-start gap-3">
        <Wallet className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-foreground">Workspace turn budget</p>
          <p className="text-xs text-muted-foreground">
            Govern the per-turn dollar budget every member in this workspace runs under.
            A <strong>hard ceiling</strong> clamps every member&apos;s effective budget — they
            cannot exceed it and the enforcement mode can only get stricter. A{" "}
            <strong>default</strong> only seeds a member who hasn&apos;t set their own budget;
            they can still raise or lower it.
          </p>
        </div>
      </div>

      <WorkspaceBudgetForm
        initial={policy}
        canEdit={canEdit}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
    </div>
  );
}
