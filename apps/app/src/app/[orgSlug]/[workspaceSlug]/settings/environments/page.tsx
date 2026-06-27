import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
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

export const dynamic = "force-dynamic";

export default async function EnvironmentsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const [wsRoleRow] = await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
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
  const environments: EnvironmentSummary[] = await readEnvironmentsAction({
    orgSlug,
    workspaceSlug,
  }).catch(() => []);
  const secretKeys: SecretKeySummary[] = await readSecretKeysAction({
    orgSlug,
    workspaceSlug,
  }).catch(() => []);

  return (
    <EnvironmentsPanel
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      canManage={canManage}
      environments={environments}
      secretKeys={secretKeys}
      importEnvAction={importEnvAction}
      upsertKeyAction={upsertKeyAction}
      setValueAction={setValueAction}
      unsetValueAction={unsetValueAction}
      deleteKeyAction={deleteKeyAction}
      createEnvironmentAction={createEnvironmentAction}
      setDefaultEnvironmentAction={setDefaultEnvironmentAction}
    />
  );
}
