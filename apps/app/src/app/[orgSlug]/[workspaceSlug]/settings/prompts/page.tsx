/**
 * page.tsx — Workspace → Settings → Prompts.
 *
 * Reads current prompt settings via the `prompt.settings.read` capability and
 * renders the PromptSettingsForm. Mirrors the workspace model settings page
 * structure (auth, resolve org/workspace, heading + form).
 */
import type { Metadata } from "next";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import { resolvePrompt, chatSystemPrompt } from "@oxagen/ai";
import "@oxagen/handlers/register";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { getEnterpriseAccess } from "@/lib/enterprise";
import { PromptSettingsForm } from "./prompt-settings-form";
import { SystemPromptReadonly } from "./system-prompt-readonly";
import type { PromptSettingsReadOutput } from "./prompt-settings-action";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Prompt Settings — Workspace Settings",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function WorkspacePromptsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);

  const ctx = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  // Resolve Enterprise entitlement alongside settings so the form correctly
  // unlocks per-prompt overrides for Enterprise orgs.
  const [{ settings, canEdit }, enterpriseAccess] = await Promise.all([
    runInTenantScope(
      { orgId: org.id, workspaceId: ws.id },
      async () => {
        // Read current settings via capability.
        const promptSettings = (await invoke(
          "get_prompt_settings",
          {},
          ctx,
          { surface: "agent" },
        )) as PromptSettingsReadOutput;

        // Re-read the caller's workspace role to determine edit permission.
        const wsRoleRows = await withTenantDb((tx) =>
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

        const wsRole = wsRoleRows[0]?.role ?? "";
        const canEditSettings = ["owner", "admin"].includes(wsRole.toLowerCase());

        return { settings: promptSettings, canEdit: canEditSettings };
      },
    ),
    getEnterpriseAccess(org.id),
  ]);

  // Render the workspace's effective system prompt read-only for transparency.
  // The baseline chat.system prompt is a pure function of workspace context;
  // resolvePrompt appends the workspace's saved Additional instructions exactly
  // as the chat runtime does, so what admins see here is what the agent runs.
  const effectiveSystemPrompt = resolvePrompt({
    key: "chat.system",
    baseline: chatSystemPrompt({
      orgSlug,
      workspaceSlug,
      orgName: org.name,
      workspaceName: ws.name,
    }),
    config: { additionalInstructions: settings.additionalInstructions },
  });

  return (
    <div className="flex flex-col gap-8 max-w-2xl">
      <SystemPromptReadonly prompt={effectiveSystemPrompt} />
      <PromptSettingsForm
        initial={settings}
        canEdit={canEdit}
        isEnterprise={enterpriseAccess.isEnterprise}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
    </div>
  );
}
