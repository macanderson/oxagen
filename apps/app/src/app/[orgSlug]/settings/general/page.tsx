/**
 * Org general settings page — live data.
 *
 * Reads real org values (name, slug, avatarUrl) via resolveOrg + a system DB
 * read for avatarUrl (resolveOrg only returns id/name/slug/publicId).
 * The save action is updateOrgGeneralAction (general-action.ts).
 * canEdit is determined server-side from the caller's org role.
 */

import { eq } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { getSession } from "@/lib/session";
import { resolveOrg, assertOrgMember, getOrgRole } from "@/lib/resolve-org";
import { updateOrgGeneralAction } from "./general-action";
import { OrgGeneralForm } from "./general-form";

export default async function OrgGeneralSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  const [org, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);

  const viewerUserId = session?.user?.id ?? "";

  if (viewerUserId) {
    await assertOrgMember(org.id, viewerUserId);
  }

  // Read avatarUrl separately — resolveOrg only returns id/name/slug/publicId.
  // withSystemDb is correct here: same seam as resolveOrg itself (pre-tenant scope).
  const orgRows = await withSystemDb((tx) =>
    tx
      .select({ avatarUrl: schema.organizations.avatarUrl })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, org.id))
      .limit(1),
  );
  const avatarUrl = orgRows[0]?.avatarUrl ?? "";

  const viewerRole = viewerUserId
    ? await getOrgRole(org.id, viewerUserId)
    : null;
  const canEdit = ["owner", "admin"].includes(viewerRole ?? "");

  // Bind the orgSlug into the action so the client only receives FormData.
  const boundAction = updateOrgGeneralAction.bind(null, orgSlug);

  return (
    <OrgGeneralForm
      orgSlug={org.slug}
      initialName={org.name}
      initialSlug={org.slug}
      initialAvatarUrl={avatarUrl}
      canEdit={canEdit}
      action={boundAction}
    />
  );
}
