/**
 * page.tsx — Workspace → Settings → Models (live-wired).
 *
 * Server component: reads the workspace's current model defaults via the
 * `workspace.model.settings.read` capability and the caller's workspace role,
 * then renders the editable <WorkspaceModelsForm>. Writes go through
 * updateWorkspaceModelsAction → `workspace.model.settings.write` (role-gated).
 */
import type { Metadata } from "next";
import { Cpu } from "lucide-react";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind foundation handlers into the kernel so
// invoke("get_model_settings", …) resolves its handler. Without this
// the call silently has no handler at runtime (see CLAUDE.md gotcha).
import "@oxagen/handlers/register";
import type { WorkspaceModelSettingsReadOutput } from "@oxagen/oxagen/contracts/workspace.model_settings.read";
import type { ModelDefaultsValue } from "@/components/settings/model-defaults-fields";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { WorkspaceModelsForm } from "./models-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI Models — Workspace Settings",
};

const EDITOR_ROLES = new Set(["owner", "admin"]);

export default async function WorkspaceModelsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const { settings, canEdit } = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    async () => {
      // Read the caller's workspace role server-side for the canEdit affordance
      // (the write action re-checks this — never trust a client flag).
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
        "get_model_settings",
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
      )) as WorkspaceModelSettingsReadOutput;

      return { settings: read, canEdit: EDITOR_ROLES.has(role) };
    },
  );

  const initial: ModelDefaultsValue = {
    textTier: settings.defaultTextTier,
    textModel: settings.defaultTextModel,
    imageModel: settings.defaultImageModel,
    videoModel: settings.defaultVideoModel,
  };

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <div className="flex items-start gap-3">
        <Cpu className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-foreground">AI model defaults</p>
          <p className="text-xs text-muted-foreground">
            The default text tier and image/video models applied to every agent run
            and Workbench generation in this workspace. Workspace defaults take
            precedence over personal preferences for all members.
          </p>
        </div>
      </div>

      <WorkspaceModelsForm
        initial={initial}
        canEdit={canEdit}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
    </div>
  );
}
