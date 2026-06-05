"use server";
import { z } from "zod";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { grantFreeCredits } from "@oxagen/billing";
import { organizationCreate } from "@oxagen/oxagen/contracts/organization.create";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { getSessionOrRedirect } from "@/lib/session";
import { bootstrapOrgIAM } from "@oxagen/handlers/iam-provision";

// FormData schema: captures all flat fields from NewOrgForm.
// Fields forwarded via hidden inputs (type, industry, employeeSize, addressCountry,
// addressRegion, addressPlaceId) are always present but may be empty strings —
// converted to undefined downstream before DB insert.
const FormSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(2).max(40),
  type: z.enum(["personal", "business"]).default("business"),
  website: z.string().optional(),
  industry: z.string().optional(),
  employeeSize: z.string().optional(),
  billingEmail: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  addressCity: z.string().optional(),
  addressRegion: z.string().optional(),
  addressPostalCode: z.string().optional(),
  addressCountry: z.string().optional(),
  addressPlaceId: z.string().optional(),
});

// Postgres unique_violation. Mirrors isSlugConflict in workspace.create.ts and
// the organization/workspace handlers — match the structured error code rather
// than sniffing the message string, which is locale- and driver-dependent.
function isSlugConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

// Coerce an empty string to undefined so we don't write blank strings into
// optional columns.
function nonEmpty(s: string | undefined): string | undefined {
  return s && s.trim().length > 0 ? s.trim() : undefined;
}

// One server action wraps two capabilities so tenant creation always
// leaves the user inside at least one workspace. Both inserts share a
// transaction so partial state is impossible.
export async function createOrgAction(
  formData: FormData,
): Promise<{ ok: true; orgSlug: string; workspaceSlug: string } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  const raw = Object.fromEntries(formData);
  const parsedForm = FormSchema.safeParse(raw);
  if (!parsedForm.success) {
    return { ok: false, error: parsedForm.error.issues[0]?.message ?? "Invalid form input" };
  }

  const fd = parsedForm.data;

  // Validate core org identity fields through the capability contract.
  const orgInput = organizationCreate.input.safeParse({
    name: fd.name,
    slug: fd.slug,
  });
  if (!orgInput.success) {
    return { ok: false, error: orgInput.error.issues[0]?.message ?? "Invalid organization" };
  }

  const workspaceInput = workspaceCreate.input.safeParse({
    name: "Default",
    slug: "default",
  });
  if (!workspaceInput.success) return { ok: false, error: "Invalid workspace" };

  // Normalise optional fields — empty strings become undefined.
  const orgType = fd.type;
  const isBusiness = orgType === "business";

  const website = isBusiness ? nonEmpty(fd.website) : undefined;
  const industry = isBusiness ? nonEmpty(fd.industry) : undefined;
  const employeeSize = isBusiness ? nonEmpty(fd.employeeSize) : undefined;
  const billingEmail = nonEmpty(fd.billingEmail);

  // Build billing address only when the three required fields are present.
  const line1 = nonEmpty(fd.addressLine1);
  const city = nonEmpty(fd.addressCity);
  const postalCode = nonEmpty(fd.addressPostalCode);
  const country = nonEmpty(fd.addressCountry);
  const hasBillingAddress = Boolean(line1 && city && postalCode && country);

  const billingProfile =
    billingEmail !== undefined || hasBillingAddress
      ? {
          billingEmail: billingEmail ?? null,
          addressLine1: line1 ?? null,
          addressLine2: nonEmpty(fd.addressLine2) ?? null,
          addressCity: city ?? null,
          addressRegion: nonEmpty(fd.addressRegion) ?? null,
          addressPostalCode: postalCode ?? null,
          addressCountry: country ?? null,
          addressPlaceId: nonEmpty(fd.addressPlaceId) ?? null,
        }
      : null;

  try {
    const result = await db().transaction(async (tx) => {
      const [tenant] = await tx
        .insert(schema.organizations)
        .values({
          name: orgInput.data.name,
          slug: orgInput.data.slug,
          planType: orgInput.data.planSlug,
          status: "active",
          type: orgType,
          website: website ?? null,
          industry: industry ?? null,
          employeeSize: employeeSize ?? null,
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

      // Insert billing profile when billing email or any address field is present.
      if (billingProfile) {
        await tx.insert(schema.orgBillingProfiles).values({
          orgId: tenant.id,
          ...billingProfile,
          createdByUserId: session.user.id,
          updatedByUserId: session.user.id,
        });
      }

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
    // The only unique index reachable here is organizations_slug_idx — the
    // workspace insert always uses slug "default" under a freshly-minted org id,
    // so a 23505 means the org slug collided.
    if (isSlugConflict(err)) {
      return { ok: false, error: `Slug "${orgInput.data.slug}" is already taken` };
    }
    const message = err instanceof Error ? err.message : "Failed to create organization";
    return { ok: false, error: message };
  }
}
