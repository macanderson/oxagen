// cost_center.shared.ts — the reads the cost-center handlers share (ADR-142):
// the organization's live labels, each with how many agents and workspaces
// name it, and the check that a label is live before anything is charged to it.
//
// The list is `cost.cost_centers` (org_only RLS). The counts span every
// workspace in the organization, so the reads run through withOrgDb, which
// widens the READ to the organization and never a write (ADR-086).
import type { CostCenter } from "@oxagen/oxagen/contracts/cost_center.shared";
import { schema, withOrgDb, type Tx } from "@oxagen/database";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";

const centers = schema.costCenters;

type CenterRow = typeof centers.$inferSelect;

/** A row as the contract's view, with the counts beside it. */
export function toCostCenter(
  row: CenterRow,
  counts: { agents: number; workspaces: number },
): CostCenter {
  return {
    id: row.publicId,
    label: row.label,
    description: row.description,
    agents: counts.agents,
    workspaces: counts.workspaces,
    createdAt: row.createdAt.toISOString(),
  };
}

/** How many live agents and workspaces of the organization name each label, keyed case-insensitively. */
async function readAssignmentCounts(
  tx: Tx,
  orgId: string,
): Promise<Map<string, { agents: number; workspaces: number }>> {
  const agents = await tx
    .select({
      label: sql<string>`lower(${schema.agents.costCenter})`,
      n: count(),
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        isNull(schema.agents.deletedAt),
        sql`${schema.agents.costCenter} is not null`,
      ),
    )
    .groupBy(sql`lower(${schema.agents.costCenter})`);
  const workspaces = await tx
    .select({
      label: sql<string>`lower(${schema.workspaces.costCenter})`,
      n: count(),
    })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.orgId, orgId),
        isNull(schema.workspaces.archivedAt),
        sql`${schema.workspaces.costCenter} is not null`,
      ),
    )
    .groupBy(sql`lower(${schema.workspaces.costCenter})`);
  const out = new Map<string, { agents: number; workspaces: number }>();
  const at = (label: string) => {
    const entry = out.get(label) ?? { agents: 0, workspaces: 0 };
    out.set(label, entry);
    return entry;
  };
  for (const r of agents) at(r.label).agents = Number(r.n);
  for (const r of workspaces) at(r.label).workspaces = Number(r.n);
  return out;
}

/** The organization's live labels by label, with their counts. */
export async function readCostCenters(orgId: string): Promise<CostCenter[]> {
  return withOrgDb(async (tx) => {
    const rows = await tx
      .select()
      .from(centers)
      .where(and(eq(centers.orgId, orgId), isNull(centers.deletedAt)))
      .orderBy(asc(sql`lower(${centers.label})`));
    const counts = await readAssignmentCounts(tx, orgId);
    return rows.map((row) =>
      toCostCenter(
        row,
        counts.get(row.label.toLowerCase()) ?? { agents: 0, workspaces: 0 },
      ),
    );
  });
}

/** The live row for a label, compared case-insensitively; null when the organization has none. */
export async function readLiveCostCenter(
  tx: Tx,
  orgId: string,
  label: string,
): Promise<CenterRow | null> {
  const rows = await tx
    .select()
    .from(centers)
    .where(
      and(
        eq(centers.orgId, orgId),
        eq(centers.label, label),
        isNull(centers.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
