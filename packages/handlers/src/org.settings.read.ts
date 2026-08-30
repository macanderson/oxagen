// audit-exempt: read-only org-profile fetch — emits no privileged state change; the kernel capability.invoke_* audit covers access.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  orgSettingsRead,
  ORG_EMPLOYEE_SIZES,
  type OrgSettingsReadOutput,
} from "@oxagen/oxagen/contracts/org.settings.read";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
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

type OrgRow = {
  name: string;
  slug: string;
  avatarUrl: string | null;
  website: string | null;
  industry: string | null;
  employeeSize: string | null;
  type: string;
};

// Normalize the free-text DB columns to the contract's closed unions. The
// employee_size + type CHECK constraints guarantee valid values, but the
// columns are typed `text`, so coerce defensively and fall back safely.
export function mapOrgSettingsRow(row: OrgRow): OrgSettingsReadOutput {
  const employeeSize =
    row.employeeSize &&
    (ORG_EMPLOYEE_SIZES as readonly string[]).includes(row.employeeSize)
      ? (row.employeeSize as (typeof ORG_EMPLOYEE_SIZES)[number])
      : null;
  return {
    name: row.name,
    slug: row.slug,
    avatarUrl: row.avatarUrl ?? null,
    website: row.website ?? null,
    industry: row.industry ?? null,
    employeeSize,
    type: row.type === "personal" ? "personal" : "business",
  };
}

// Reads org.organizations for the active org (org-scoped; RLS limits the row to
// ctx.orgId). Kernel handles metering + IAM via invoke().
export const orgSettingsReadHandler: CapabilityHandler<
  typeof orgSettingsRead
> = async (_input, ctx) => {
  const row = await withTenantDb((tx) =>
    tx.query.organizations.findFirst({
      where: eq(schema.organizations.id, ctx.orgId),
      columns: READ_COLUMNS,
    }),
  );

  if (!row) {
    logger.warn(
      { orgId: ctx.orgId },
      "org.settings.read: organization not found",
    );
    throw new Error("Organization not found");
  }

  logger.info(
    { orgId: ctx.orgId, surface: ctx.surface },
    "org.settings.read: returned org settings",
  );
  return mapOrgSettingsRow(row);
};
