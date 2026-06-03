"use server";
import { z } from "zod";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { grantFreeCredits } from "@oxagen/billing";
import { organizationCreate } from "@oxagen/oxagen/contracts/organization.create";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { getSessionOrRedirect } from "@/lib/session";
import { bootstrapOrgIAM } from "@oxagen/handlers/iam-provision";

const FormSchema = z.object({
  name: z.string(),
  slug: z.string(),
});

// One server action wraps two capabilities so tenant creation always
// leaves the user inside at least one workspace. Both inserts share a
// transaction so partial state is impossible.
export async function createOrgAction(
  formData: FormData,
): Promise<{ ok: true; orgSlug: string; workspaceSlug: string } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  const raw = Object.fromEntries(formData);
  const parsedForm = FormSchema.safeParse(raw);
  if (!parsedForm.success) return { ok: false, error: "Invalid form input" };

  const orgInput = organizationCreate.input.safeParse({
    name: parsedForm.data.name,
    slug: parsedForm.data.slug,
  });
  if (!orgInput.success) return { ok: false, error: orgInput.error.issues[0]?.message ?? "Invalid organization" };

  const workspaceInput = workspaceCreate.input.safeParse({
    name: "Default",
    slug: "default",
  });
  if (!workspaceInput.success) return { ok: false, error: "Invalid workspace" };

  try {
    const result = await db().transaction(async (tx) => {
      const [tenant] = await tx
        .insert(schema.organizations)
        .values({
          name: orgInput.data.name,
          slug: orgInput.data.slug,
          planType: orgInput.data.planSlug,
          status: "active",
          createdByUserId: session.user.id,
          updatedByUserId: session.user.id,
        })
        .returning();
      if (!tenant) throw new Error("Insert failed");

      await tx.insert(schema.orgUsers).values({
        orgId: tenant.id,
        userId: session.user.id,
        role: "owner",
        joinedAt: new Date(),
        createdByUserId: session.user.id,
        updatedByUserId: session.user.id,
      });

      const [workspace] = await tx
        .insert(schema.workspaces)
        .values({
          orgId: tenant.id,
          name: workspaceInput.data.name,
          slug: workspaceInput.data.slug,
          createdByUserId: session.user.id,
          updatedByUserId: session.user.id,
        })
        .returning();
      if (!workspace) throw new Error("Workspace insert failed");

      await tx.insert(schema.workspaceUsers).values({
        workspaceId: workspace.id,
        userId: session.user.id,
        role: "owner",
        joinedAt: new Date(),
        createdByUserId: session.user.id,
        updatedByUserId: session.user.id,
      });

      // Bootstrap full IAM state atomically with org creation: system roles,
      // owner principal, owner role assignment, and role_grants from defaultRoles.
      await bootstrapOrgIAM({
        orgId: tenant.id,
        ownerUserId: session.user.id,
        actorUserId: session.user.id,
        tx,
      });

      return { orgId: tenant.id, orgSlug: tenant.slug, workspaceSlug: workspace.slug };
    });

    // Grant the non-expiring Free signup credits ($5) outside the org
    // transaction, mirroring organizationCreateHandler. A grant hiccup must not
    // fail signup — the org already exists and the grant is recoverable.
    try {
      await grantFreeCredits(result.orgId);
    } catch (grantErr) {
      console.error("[onboarding] grantFreeCredits failed for org", result.orgId, grantErr);
    }

    return { ok: true, orgSlug: result.orgSlug, workspaceSlug: result.workspaceSlug };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create organization";
    if (message.toLowerCase().includes("unique")) {
      return { ok: false, error: "Slug is already taken" };
    }
    return { ok: false, error: message };
  }
}
