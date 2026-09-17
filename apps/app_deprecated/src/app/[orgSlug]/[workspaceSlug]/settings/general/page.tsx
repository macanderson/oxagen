import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { getSession } from "@/lib/session";
import { WorkspaceGeneralForm } from "./workspace-general-form";
import { WorkspaceMembersPanel } from "./workspace-members-panel";
import {
  GeneralSettingsTabs,
  type GeneralSettingsTab,
} from "./general-settings-tabs";

/**
 * Workspace Settings → General.
 *
 * Tabbed shell with two in-page sub-tabs: "General" (the workspace identity
 * form) and "Members" (the read-only workspace roster), controlled by the
 * `?tab=general|members` search param — see general-settings-tabs.tsx. Both
 * panels' data is fetched up front (in parallel) so switching tabs is an
 * instant client-side toggle with no re-fetch/flash.
 */
export default async function SettingsGeneralPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const sp = await searchParams;
  const initialTab: GeneralSettingsTab =
    sp.tab === "members" ? "members" : "general";

  const org = await resolveOrg(orgSlug);
  const [ws, session] = await Promise.all([
    resolveWorkspace(org.id, workspaceSlug),
    getSession(),
  ]);

  return (
    <GeneralSettingsTabs
      initialTab={initialTab}
      generalPanel={
        <WorkspaceGeneralForm
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={ws.id}
          initialName={ws.name}
          initialSlug={ws.slug}
          initialDescription={ws.description}
          initialAvatarUrl={ws.avatarUrl}
        />
      }
      membersPanel={
        <WorkspaceMembersPanel
          orgId={org.id}
          workspaceId={ws.id}
          workspaceName={ws.name}
          orgSlug={orgSlug}
          viewerUserId={session?.user?.id ?? ""}
        />
      }
    />
  );
}
