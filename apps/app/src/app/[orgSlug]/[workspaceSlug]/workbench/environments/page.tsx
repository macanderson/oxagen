/**
 * page.tsx — Workspace → Workbench → Environments (first-class page).
 *
 * Named environment-variable/secret sets that agents, sandboxes, and code
 * execution run with. Promoted from workspace settings to a first-class
 * Workbench page — environment config is a build concern, not a settings
 * one. Sandbox templates (which bind to these environments) live on the
 * Sandboxes page.
 */
import type { Metadata } from "next";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import { PageHeader } from "@/components/ui/page-header";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { EnvironmentsPanel } from "./environments-panel";
import {
  readEnvironmentsAction,
  readSecretKeysAction,
  importEnvAction,
  upsertKeyAction,
  setValueAction,
  unsetValueAction,
  deleteKeyAction,
  createEnvironmentAction,
  setDefaultEnvironmentAction,
  type EnvironmentSummary,
  type SecretKeySummary,
} from "./actions";

export const metadata: Metadata = {
  title: "Environments | Workbench",
};

export default async function WorkbenchEnvironmentsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const [wsRoleRow] = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
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
      ),
  );
  const wsRole = (wsRoleRow?.role ?? "viewer").toLowerCase();
  const canManage = wsRole === "owner" || wsRole === "admin";

  // Masked reads — values never cross to the client (the grid shows ••••).
  // A read failure must not render as an empty grid with no trace: it looks to
  // the user like their environments/secrets were deleted. Log each failure and
  // surface a load-error flag so the panel can show a notice instead.
  // The two reads have no data dependency, so run them concurrently rather than
  // awaiting serially — halves the page's data-fetch latency.
  const [environmentsRead, secretKeysRead] = await Promise.all([
    readEnvironmentsAction({
      orgSlug,
      workspaceSlug,
    }).then(
      (data) => ({ data, failed: false as const }),
      (err) => {
        logger.error(
          { err, orgSlug, workspaceSlug },
          "environments: readEnvironmentsAction failed — rendering empty grid with load-error notice",
        );
        return { data: [] as EnvironmentSummary[], failed: true as const };
      },
    ),
    readSecretKeysAction({
      orgSlug,
      workspaceSlug,
    }).then(
      (data) => ({ data, failed: false as const }),
      (err) => {
        logger.error(
          { err, orgSlug, workspaceSlug },
          "environments: readSecretKeysAction failed — rendering empty grid with load-error notice",
        );
        return { data: [] as SecretKeySummary[], failed: true as const };
      },
    ),
  ]);
  const environments = environmentsRead.data;
  const secretKeys = secretKeysRead.data;
  const loadError = environmentsRead.failed || secretKeysRead.failed;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Environments"
        description="Named environment-variable and secret sets that agents, sandboxes, and code execution run with."
        className="pb-0"
      />
      <EnvironmentsPanel
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        environments={environments}
        secretKeys={secretKeys}
        loadError={loadError}
        importEnvAction={importEnvAction}
        upsertKeyAction={upsertKeyAction}
        setValueAction={setValueAction}
        unsetValueAction={unsetValueAction}
        deleteKeyAction={deleteKeyAction}
        createEnvironmentAction={createEnvironmentAction}
        setDefaultEnvironmentAction={setDefaultEnvironmentAction}
      />
    </div>
  );
}
