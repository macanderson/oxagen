/**
 * Capability & Contract catalog — the org-wide governed contract registry.
 *
 * The flagship governance surface: every typed capability contract rendered
 * as the one enforced object binding identity → knowledge scope → permitted
 * action → commercial terms → verified outcome → audit record. Data comes
 * from the list_capability_registry contract (the runtime counterpart of
 * `pnpm check:manifest`); the drawer loads get_capability_registry plus 30d
 * usage and recent audit events per contract.
 *
 * Registry-read failure renders a full-page error state (the page is
 * unusable without it, per spec); drawer sub-reads degrade independently.
 */

import type { CapabilityRegistryListOutput } from "@oxagen/oxagen/contracts/capability.registry.list";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";
import { invokeOrgCapability } from "../_lib/invoke-org";
import { CatalogView } from "./_components/catalog-view";

export default async function CapabilitiesCatalogPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ orgSlug }, sp] = await Promise.all([params, searchParams]);
  const [session, tenant] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
  await assertOrgMember(tenant.id, session.user.id);

  let registry: CapabilityRegistryListOutput | null = null;
  try {
    registry = await invokeOrgCapability<CapabilityRegistryListOutput>(
      tenant.id,
      session.user.id,
      "list_capability_registry",
      { limit: 1000, offset: 0 },
    );
  } catch (err) {
    logger.error(
      { err, orgId: tenant.id },
      "governance/capabilities: registry read failed",
    );
  }

  if (!registry) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <ErrorState
          title="Couldn't load the contract registry"
          description="The capability catalog is unavailable right now. Reload to try again."
        />
      </div>
    );
  }

  const one = (v: string | string[] | undefined): string | undefined =>
    typeof v === "string" ? v : undefined;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Every capability is a typed contract — identity, knowledge scope,
        permitted action, commercial terms, verified outcome, and audit record
        bound into one enforced object. Click a row to inspect the full chain.
      </p>
      <CatalogView
        orgSlug={orgSlug}
        rows={registry.capabilities}
        domains={registry.domains}
        initialFilter={{
          q: one(sp["q"]) ?? "",
          domain: one(sp["domain"]) ?? "",
          missingLayer: one(sp["missingLayer"]) ?? "",
          gapOnly: one(sp["gaps"]) === "1",
        }}
      />
    </div>
  );
}
