"use server";
import { z } from "zod";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { tenantCreate } from "@oxagen/oxagen/contracts/tenant.create";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { getSessionOrRedirect } from "@/lib/session";

const FormSchema = z.object({
  name: z.string(),
  slug: z.string(),
});

// One server action wraps two capabilities so tenant creation always
// leaves the user inside at least one workspace. Both inserts share a
// transaction so partial state is impossible.
export async function createTenantAction(
  formData: FormData,
): Promise<{ ok: true; tenantSlug: string; workspaceSlug: string } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  const raw = Object.fromEntries(formData);
  const parsedForm = FormSchema.safeParse(raw);
  if (!parsedForm.success) return { ok: false, error: "Invalid form input" };

  const tenantInput = tenantCreate.input.safeParse({
    name: parsedForm.data.name,
    slug: parsedForm.data.slug,
  });
  if (!tenantInput.success) return { ok: false, error: tenantInput.error.issues[0]?.message ?? "Invalid organization" };

  const workspaceInput = workspaceCreate.input.safeParse({
    name: "Default",
    slug: "default",
  });
  if (!workspaceInput.success) return { ok: false, error: "Invalid workspace" };

  try {
    const result = await db().transaction(async (tx) => {
      const [tenant] = await tx
        .insert(schema.tenants)
        .values({
          name: tenantInput.data.name,
          slug: tenantInput.data.slug,
          planType: tenantInput.data.planSlug,
          status: "active",
          createdByUserId: session.user.id,
          updatedByUserId: session.user.id,
        })
        .returning();
      if (!tenant) throw new Error("Insert failed");

      await tx.insert(schema.tenantUsers).values({
        tenantId: tenant.id,
        userId: session.user.id,
        role: "owner",
        joinedAt: new Date(),
        createdByUserId: session.user.id,
        updatedByUserId: session.user.id,
      });

      const [workspace] = await tx
        .insert(schema.workspaces)
        .values({
          tenantId: tenant.id,
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

      return { tenantSlug: tenant.slug, workspaceSlug: workspace.slug };
    });

    return { ok: true, ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create organization";
    if (message.toLowerCase().includes("unique")) {
      return { ok: false, error: "Slug is already taken" };
    }
    return { ok: false, error: message };
  }
}
