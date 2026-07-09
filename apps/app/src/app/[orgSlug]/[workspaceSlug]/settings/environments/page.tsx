import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { EnvironmentsPanel } from "./environments-panel";
import { SandboxTemplatesPanel } from "./sandbox-templates-panel";
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
import {
  readTemplatesAction,
  readToolSourcesAction,
  createTemplateAction,
  updateTemplateAction,
  setTemplateToolsAction,
  setDefaultTemplateAction,
  deleteTemplateAction,
  exportTemplateAction,
  importTemplateAction,
  type SandboxTemplateSummary,
  type ToolSourceOption,
} from "./sandbox-actions";

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
  // A read failure must not render as an empty grid with no trace: it looks to
  // the user like their environments/secrets were deleted. Log each failure and
  // surface a load-error flag so the panel can show a notice instead.
  const environmentsRead = await readEnvironmentsAction({
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
  );
  const secretKeysRead = await readSecretKeysAction({
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
  );
  const environments = environmentsRead.data;
  const secretKeys = secretKeysRead.data;
  const loadError = environmentsRead.failed || secretKeysRead.failed;

  // Sandbox templates + tool suggestions. Both degrade to empty on failure so a
  // read error never blanks the page — the section simply shows no templates.
  const templates = await readTemplatesAction({ orgSlug, workspaceSlug }).then(
    (data) => data,
    (err) => {
      logger.error(
        { err, orgSlug, workspaceSlug },
        "environments: readTemplatesAction failed — rendering empty templates section",
      );
      return [] as SandboxTemplateSummary[];
    },
  );
  const toolSources = await readToolSourcesAction({ orgSlug, workspaceSlug }).then(
    (data) => data,
    () => [] as ToolSourceOption[],
  );

  return (
    <div className="flex flex-col gap-10">
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
      <SandboxTemplatesPanel
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        environments={environments}
        secretKeys={secretKeys}
        templates={templates}
        toolSources={toolSources}
        createTemplateAction={createTemplateAction}
        updateTemplateAction={updateTemplateAction}
        setTemplateToolsAction={setTemplateToolsAction}
        setDefaultTemplateAction={setDefaultTemplateAction}
        deleteTemplateAction={deleteTemplateAction}
        exportTemplateAction={exportTemplateAction}
        importTemplateAction={importTemplateAction}
      />
    </div>
  );
}
