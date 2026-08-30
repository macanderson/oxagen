// audit-exempt: org-profile field edit (name/slug/website/industry) — no fitting security-event type exists in the taxonomy (no org.settings_updated); covered by the kernel capability.invoke_* audit. Do not invent a type.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgSettingsWrite } from "@oxagen/oxagen/contracts/org.settings.write";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { mapOrgSettingsRow } from "./org.settings.read";
import { logger } from "./logger";

const READ_COLUMNS = {
  name: true,
  slug: true,
  avatarUrl: true,
  website: true,
  industry: true,
  employeeSize: true,
  type: true,
} as const;

// Partial update of org.organizations for the active org. Every field is
// optional: omit = unchanged, value = set, null = clear (nullable fields only).
// Kernel handles metering + IAM via invoke(); slug collisions surface as a
// clean error instead of a raw constraint violation.
export const orgSettingsWriteHandler: CapabilityHandler<
  typeof orgSettingsWrite
> = async (input, ctx) => {
  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.slug !== undefined) updates.slug = input.slug;
  if (input.avatarUrl !== undefined) updates.avatarUrl = input.avatarUrl;
  if (input.website !== undefined) updates.website = input.website;
  if (input.industry !== undefined) updates.industry = input.industry;
  if (input.employeeSize !== undefined)
    updates.employeeSize = input.employeeSize;

  const row = await withTenantDb(async (tx) => {
    if (Object.keys(updates).length > 0) {
      try {
        await tx
          .update(schema.organizations)
          .set({ ...updates, updatedAt: new Date() })
          .where(eq(schema.organizations.id, ctx.orgId));
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new Error(
            `Slug "${input.slug}" is already in use by another organization`,
          );
        }
        throw err;
      }
    }
    return tx.query.organizations.findFirst({
      where: eq(schema.organizations.id, ctx.orgId),
      columns: READ_COLUMNS,
    });
  });

  if (!row) {
    logger.warn(
      { orgId: ctx.orgId },
      "org.settings.write: organization not found",
    );
    throw new Error("Organization not found");
  }

  logger.info(
    { orgId: ctx.orgId, surface: ctx.surface, fields: Object.keys(updates) },
    "org.settings.write: updated org settings",
  );
  return mapOrgSettingsRow(row);
};
