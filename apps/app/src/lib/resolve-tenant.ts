import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";

export interface ResolvedTenant {
  id: string;
  publicId: string;
  name: string;
  slug: string;
}

export interface ResolvedWorkspace {
  id: string;
  publicId: string;
  tenantId: string;
  name: string;
  slug: string;
}

// Per-request memoization keeps slug → row resolution at one query per
// boundary, even when several RSCs in the same render need the tenant.
export const resolveTenant = cache(async (slug: string): Promise<ResolvedTenant> => {
  const rows = await db()
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, slug))
    .limit(1);
  const row = rows[0];
  if (!row) notFound();
  return {
    id: row.id,
    publicId: row.publicId,
    name: row.name,
    slug: row.slug,
  };
});

export const resolveWorkspace = cache(
  async (tenantId: string, slug: string): Promise<ResolvedWorkspace> => {
    const rows = await db()
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.tenantId, tenantId), eq(schema.workspaces.slug, slug)))
      .limit(1);
    const row = rows[0];
    if (!row) notFound();
    return {
      id: row.id,
      publicId: row.publicId,
      tenantId: row.tenantId,
      name: row.name,
      slug: row.slug,
    };
  },
);
