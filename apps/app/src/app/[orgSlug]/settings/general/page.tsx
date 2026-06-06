/**
 * Org general settings page — static mock UI.
 *
 * Renders OrgGeneralForm with hardcoded mock values.
 * ZERO server data dependencies — all data is inline mock constants.
 * Will be wired to live org data in OXA-XXXX (see parent ticket).
 */

import { OrgGeneralForm } from "./general-form";

// ---------------------------------------------------------------------------
// Mock no-op server action — safe placeholder for the static mock.
// ---------------------------------------------------------------------------

async function noopAction(
  _formData: FormData,
): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
  "use server";
  // Static mock — not wired to DB. Wire in OXA-XXXX.
  return { ok: false, error: "Preview only — saving is not wired yet." };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function OrgGeneralSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  return (
    <div className="flex flex-col gap-4">
      {/* Preview pill */}
      <p className="text-[11px] text-muted-foreground/60 font-medium">
        Preview &middot; not yet wired to live data
      </p>
      <OrgGeneralForm
        orgSlug={orgSlug}
        initialName="Acme Corp"
        initialSlug={orgSlug}
        initialAvatarUrl=""
        canEdit={false}
        action={noopAction}
      />
    </div>
  );
}
