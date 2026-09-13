// Create the tenant and its first workspace: gate step 1 in production.
//
// Carried over from apps/app_deprecated/src/app/(onboarding)/new-organization/
// actions.ts, with two changes the new screen needs: the person picks the
// immutable organization namespace (spec App. A, 2–6 characters) instead of
// having one derived, and names the first workspace instead of getting
// "Default". The org row, the owner membership, the workspace, its owner
// membership, IAM bootstrap and the built-in agents share one transaction, so a
// partial tenant cannot exist. Credits and workspace seeds run after it and are
// recoverable, so their failure never fails sign-up.
//
// withSystemDb is deliberate: no tenant exists yet, so no scope can be entered;
// this call is what creates the first tenant identity.
import "server-only";
import { RESERVED_ORG_SLUGS, RESERVED_WORKSPACE_SLUGS } from "./agent-key";
import type { OrganizationFormValue } from "./org-form";

export type CreateOrganizationResult =
  | { ok: true; orgSlug: string; workspaceSlug: string }
  | {
      ok: false;
      error:
        | "slugTaken"
        | "slugReserved"
        | "workspaceSlugReserved"
        | "namespaceTaken"
        | "invalid"
        | "failed";
    };

export async function createOrganization(
  userId: string,
  form: OrganizationFormValue,
): Promise<CreateOrganizationResult> {
  // Re-checked here, not only in OrganizationForm: a route segment taken as an
  // org or workspace slug makes that tenant unreachable, and the create_org
  // contract does not know the app's routes yet.
  if (RESERVED_ORG_SLUGS.has(form.slug.trim()))
    return { ok: false, error: "slugReserved" };
  if (RESERVED_WORKSPACE_SLUGS.has(form.workspaceSlug.trim()))
    return { ok: false, error: "workspaceSlugReserved" };
  const [{ organizationCreate }, { workspaceCreate }] = await Promise.all([
    import("@oxagen/oxagen/contracts/org.create"),
    import("@oxagen/oxagen/contracts/workspace.create"),
  ]);
  // The same business rules the API and MCP surfaces enforce: a crafted POST cannot bypass them.
  const org = organizationCreate.input.safeParse({
    name: form.name,
    slug: form.slug,
    type: "business",
  });
  const workspace = workspaceCreate.input.safeParse({
    name: form.workspaceName,
    slug: form.workspaceSlug,
  });
  if (!org.success || !workspace.success)
    return { ok: false, error: "invalid" };

  const [
    { deriveNamespace, isUniqueViolation, schema, withSystemDb },
    { logger },
  ] = await Promise.all([
    import("@oxagen/database"),
    import("@oxagen/handlers/logger"),
  ]);

  try {
    const created = await withSystemDb(async (tx) => {
      const [tenant] = await tx
        .insert(schema.organizations)
        .values({
          name: org.data.name,
          slug: org.data.slug,
          namespace: form.namespace,
          planType: org.data.planSlug,
          status: "active",
          type: org.data.type,
          createdByUserId: userId,
          updatedByUserId: userId,
        })
        .returning();
      if (!tenant) throw new Error("organization insert returned no row");

      await tx.insert(schema.orgUsers).values({
        orgId: tenant.id,
        userId,
        role: "owner",
        joinedAt: new Date(),
        createdByUserId: userId,
        updatedByUserId: userId,
      });

      // A brand-new org has no other workspaces; the (org_id, namespace) unique index still guards.
      const [ws] = await tx
        .insert(schema.workspaces)
        .values({
          orgId: tenant.id,
          name: workspace.data.name,
          slug: workspace.data.slug,
          namespace: deriveNamespace(workspace.data.slug, new Set<string>()),
          createdByUserId: userId,
          updatedByUserId: userId,
        })
        .returning();
      if (!ws) throw new Error("workspace insert returned no row");

      await tx.insert(schema.workspaceUsers).values({
        workspaceId: ws.id,
        userId,
        role: "owner",
        joinedAt: new Date(),
        createdByUserId: userId,
        updatedByUserId: userId,
      });

      const [{ bootstrapOrgIAM }, { bootstrapWorkspaceAgents }] =
        await Promise.all([
          import("@oxagen/handlers/iam-provision"),
          import("@oxagen/handlers/workspace-agents"),
        ]);
      await bootstrapOrgIAM({
        orgId: tenant.id,
        ownerUserId: userId,
        actorUserId: userId,
        tx,
      });
      await bootstrapWorkspaceAgents({
        workspaceId: ws.id,
        orgId: tenant.id,
        userId,
        tx,
      });

      return {
        orgId: tenant.id,
        orgSlug: tenant.slug,
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
      };
    });

    await afterCreate(created.orgId, created.workspaceId, logger);
    return {
      ok: true,
      orgSlug: created.orgSlug,
      workspaceSlug: created.workspaceSlug,
    };
  } catch (err) {
    if (isUniqueViolation(err, "organizations_slug_idx"))
      return { ok: false, error: "slugTaken" };
    if (isUniqueViolation(err, "organizations_namespace_idx"))
      return { ok: false, error: "namespaceTaken" };
    // Never surface a driver message: it can carry schema and query details.
    logger.error(
      { err, slug: form.slug },
      "[onboarding] createOrganization failed",
    );
    return { ok: false, error: "failed" };
  }
}

type Logger = { error: (obj: object, msg: string) => void };

async function afterCreate(
  orgId: string,
  workspaceId: string,
  logger: Logger,
): Promise<void> {
  const steps: Array<[string, () => Promise<unknown>]> = [
    [
      "grantFreeCredits",
      async () => (await import("@oxagen/billing")).grantFreeCredits(orgId),
    ],
    [
      "seedWorkspaceDefaultRegistrySystem",
      async () =>
        (
          await import("@oxagen/handlers/workspace-registry-seed")
        ).seedWorkspaceDefaultRegistrySystem({ orgId, workspaceId }),
    ],
    [
      "seedWorkspaceDefaultEnvironmentSystem",
      async () =>
        (
          await import("@oxagen/handlers/workspace-environment-seed")
        ).seedWorkspaceDefaultEnvironmentSystem({ orgId, workspaceId }),
    ],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      logger.error(
        { err, orgId, workspaceId },
        `[onboarding] ${name} failed; the tenant exists and this step is recoverable`,
      );
    }
  }
}
