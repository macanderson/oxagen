/**
 * page.tsx — Workspace → Settings → Models (RSC).
 *
 * Loads the workspace's current model defaults and the viewing user's personal
 * preferences, runs resolveModelDefaults() to compute override flags, then
 * renders the informational override alert and the form.
 *
 * Auth + role resolution mirrors apps/app/src/app/[orgSlug]/settings/general/page.tsx.
 */
import { and, eq } from "drizzle-orm";
import { Info } from "lucide-react";
import { db, schema } from "@oxagen/database";
import type { CapabilityContext } from "@oxagen/oxagen";
import {
  resolveModelDefaults,
  TEXT_TIERS,
  gatewayModels,
  getModel,
  vendorLabels,
} from "@oxagen/ai/catalog";
import type { ModelTier } from "@oxagen/ai/catalog";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { workspaceModelSettingsReadHandler } from "@oxagen/handlers/workspace.model.settings.read";
import { userPreferencesReadHandler } from "@oxagen/handlers/user.preferences.read";
import { WorkspaceModelsForm } from "./models-form";

// Force dynamic so the role + model reads never serve stale RSC output.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "AI Models — Workspace Settings",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a text model or tier to a human-readable label.
 * Explicit model → catalog name + vendor. Tier → TEXT_TIERS display name.
 */
function resolveTextLabel(
  model: string | null,
  tier: ModelTier | null,
): string {
  if (model !== null) {
    const entry = getModel(model);
    if (entry) {
      return `${entry.name} (${vendorLabels[entry.vendor]})`;
    }
    return model;
  }
  if (tier !== null) {
    const tierEntry = TEXT_TIERS.find((t) => t.id === tier);
    return tierEntry?.name ?? tier;
  }
  return "Default";
}

/**
 * Resolve a media model id to a human-readable label.
 */
function resolveMediaLabel(model: string | null): string {
  if (model === null) return "Default";
  const entry = getModel(model);
  if (entry) {
    return `${entry.name} (${vendorLabels[entry.vendor]})`;
  }
  return model;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function WorkspaceModelsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();

  // Resolve org + workspace — notFound() on slug mismatch.
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  // Assert org membership (IDOR guard).
  await assertOrgMember(org.id, session.user.id);

  // Re-read the caller's workspace role server-side.
  const wsRoleRows = await db()
    .select({ role: schema.workspaceUsers.role })
    .from(schema.workspaceUsers)
    .where(
      and(
        eq(schema.workspaceUsers.workspaceId, ws.id),
        eq(schema.workspaceUsers.userId, session.user.id),
      ),
    )
    .limit(1);

  const wsRole = wsRoleRows[0]?.role ?? "";
  const canEdit = ["owner", "admin"].includes(wsRole.toLowerCase());

  // Build a workspace-scoped capability context for the read calls.
  const ctx: CapabilityContext = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };

  // User-scoped context (orgId/workspaceId are unused for user.preferences.read).
  const userCtx: CapabilityContext = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };

  // Load workspace defaults + user preferences in parallel.
  const [wsSettings, userPrefs] = await Promise.all([
    workspaceModelSettingsReadHandler({}, ctx),
    userPreferencesReadHandler({}, userCtx),
  ]);

  // Compute override flags — which dimensions the workspace shadows from the user.
  const resolved = resolveModelDefaults({
    workspace: {
      defaultTextTier: wsSettings.defaultTextTier as ModelTier | null,
      defaultTextModel: wsSettings.defaultTextModel,
      defaultImageModel: wsSettings.defaultImageModel,
      defaultVideoModel: wsSettings.defaultVideoModel,
    },
    user: {
      defaultTextTier: userPrefs.defaultTextTier as ModelTier | null,
      defaultTextModel: userPrefs.defaultTextModel,
      defaultImageModel: userPrefs.defaultImageModel,
      defaultVideoModel: userPrefs.defaultVideoModel,
    },
  });

  const { overriddenByWorkspace } = resolved;
  const anyOverridden =
    overriddenByWorkspace.text ||
    overriddenByWorkspace.image ||
    overriddenByWorkspace.video;

  return (
    <div className="flex flex-col gap-6">
      {/* Informational override alert */}
      {anyOverridden && (
        <Alert variant="info" className="max-w-2xl">
          <Info aria-hidden="true" />
          <AlertTitle>
            This workspace sets default models — your personal preferences for
            these are not applied here.
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-2 flex flex-col gap-1.5 text-sm">
              {overriddenByWorkspace.text && (
                <li>
                  <span className="font-medium text-foreground">
                    Default agent model
                  </span>{" "}
                  — workspace uses{" "}
                  <strong>
                    {resolveTextLabel(
                      wsSettings.defaultTextModel,
                      wsSettings.defaultTextTier as ModelTier | null,
                    )}
                  </strong>{" "}
                  (your personal default is ignored in this workspace)
                </li>
              )}
              {overriddenByWorkspace.image && (
                <li>
                  <span className="font-medium text-foreground">
                    Image generation model
                  </span>{" "}
                  — workspace uses{" "}
                  <strong>
                    {resolveMediaLabel(wsSettings.defaultImageModel)}
                  </strong>{" "}
                  (your personal default is ignored in this workspace)
                </li>
              )}
              {overriddenByWorkspace.video && (
                <li>
                  <span className="font-medium text-foreground">
                    Video generation model
                  </span>{" "}
                  — workspace uses{" "}
                  <strong>
                    {resolveMediaLabel(wsSettings.defaultVideoModel)}
                  </strong>{" "}
                  (your personal default is ignored in this workspace)
                </li>
              )}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Form */}
      <WorkspaceModelsForm
        initial={{
          textTier: wsSettings.defaultTextTier as ModelTier | null,
          textModel: wsSettings.defaultTextModel,
          imageModel: wsSettings.defaultImageModel,
          videoModel: wsSettings.defaultVideoModel,
        }}
        canEdit={canEdit}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
    </div>
  );
}
