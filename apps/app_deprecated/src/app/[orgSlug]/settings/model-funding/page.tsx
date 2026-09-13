/**
 * Org model-funding settings page (ADR-053 §2–3).
 *
 * Shows who pays for the in-app assistant's tokens — the organisation's own
 * model-vendor key, or Oxagen's key under a monthly cap — and lets an owner or
 * admin change it. The redacted credential view comes from the
 * `get_model_credential` capability and the cap from the billing settings.
 * canEdit is determined server-side from the caller's org role.
 */

import { getOrgBillingSettings } from "@oxagen/billing";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: registers the capability handlers invoke() resolves.
import "@oxagen/handlers/register";
import {
  modelCredentialViewSchema,
  type ModelCredentialView,
} from "@oxagen/oxagen/contracts/org.model_credential.shared";
import { PageHeader } from "@/components/ui/page-header";
import { getSession } from "@/lib/session";
import { resolveOrg, assertOrgMember, getOrgRole } from "@/lib/resolve-org";
import {
  setModelCredentialAction,
  verifyModelCredentialAction,
  deleteModelCredentialAction,
  updateAssistantSpendCapAction,
} from "./funding-actions";
import {
  ORG_ONLY_WS,
  FUNDING_MANAGER_ROLES,
  buildOrgCapabilityContext,
} from "./funding-context";
import { FundingForm } from "./funding-form";

export const metadata = {
  title: "Model funding — Organization Settings",
};

export default async function OrgModelFundingPage({
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

  const viewerRole = viewerUserId
    ? await getOrgRole(org.id, viewerUserId)
    : null;
  const canEdit = FUNDING_MANAGER_ROLES.has((viewerRole ?? "").toLowerCase());

  // The credential read is Owner/Admin-only at the capability, so a member
  // never asks for it: they see the permission note instead of a denial.
  let view: ModelCredentialView | null = null;
  let capCents: number | null = null;
  let loadError: string | null = null;
  if (canEdit) {
    try {
      const loaded = await runInTenantScope(
        { orgId: org.id, workspaceId: ORG_ONLY_WS },
        async () => {
          const ctx = buildOrgCapabilityContext({
            orgId: org.id,
            userId: viewerUserId,
          });
          const [rawView, billing] = await Promise.all([
            invoke("get_model_credential", {}, ctx, { surface: "api" }),
            getOrgBillingSettings(org.id),
          ]);
          return {
            view: modelCredentialViewSchema.parse(rawView),
            capCents: billing.assistantSpendCapCents,
          };
        },
      );
      view = loaded.view;
      capCents = loaded.capCents;
    } catch {
      loadError =
        "The current key status could not be loaded. Reload the page to try again.";
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Model funding"
        description="Choose who pays for the tokens the in-app assistant uses."
      />
      <FundingForm
        orgSlug={org.slug}
        view={view}
        capCents={capCents}
        canEdit={canEdit}
        loadError={loadError}
        setAction={setModelCredentialAction.bind(null, orgSlug)}
        verifyAction={verifyModelCredentialAction.bind(null, orgSlug)}
        deleteAction={deleteModelCredentialAction.bind(null, orgSlug)}
        capAction={updateAssistantSpendCapAction.bind(null, orgSlug)}
      />
    </div>
  );
}
