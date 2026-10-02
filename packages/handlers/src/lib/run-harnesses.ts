import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import type { RunScope } from "../run.list";

/** Ledger runs carry no harness. Wrapped runs use the recorded session harness. */
export async function readRunHarnesses(
  scope: RunScope,
  runIds: readonly string[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(runIds)].filter((id) => id.startsWith("tse_"));
  if (ids.length === 0) return new Map();
  const sessions = schema.tachoSessions;
  const rows = await withTenantDb((tx) =>
    tx
      .select({ publicId: sessions.publicId, harness: sessions.harness })
      .from(sessions)
      .where(
        and(
          eq(sessions.orgId, scope.orgId),
          eq(sessions.workspaceId, scope.workspaceId),
          inArray(sessions.publicId, ids),
        ),
      ),
  );
  return new Map(rows.map((row) => [row.publicId, row.harness || null]));
}

/**
 * The harness each agent registered, by agent key (`org_ns.ws_ns.slug`),
 * within the caller's org and workspace. A run with no recorded harness, such
 * as every ledger run, shows its agent's instead. A retired agent keeps its
 * row, so its old runs still name a harness. A key whose slug names no agent
 * is left out.
 */
export async function readAgentHarnesses(
  scope: RunScope,
  agentKeys: readonly string[],
): Promise<Map<string, string>> {
  const slugOf = (key: string) => key.split(".").at(-1) ?? "";
  const slugs = [...new Set(agentKeys.map(slugOf))].filter(Boolean);
  if (slugs.length === 0) return new Map();
  const agents = schema.agents;
  const rows = await withTenantDb((tx) =>
    tx
      .select({ slug: agents.slug, harness: agents.harness })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, scope.orgId),
          eq(agents.workspaceId, scope.workspaceId),
          inArray(agents.slug, slugs),
        ),
      ),
  );
  const bySlug = new Map(rows.map((row) => [String(row.slug), row.harness]));
  const out = new Map<string, string>();
  for (const key of new Set(agentKeys)) {
    const harness = bySlug.get(slugOf(key));
    if (harness) out.set(key, harness);
  }
  return out;
}
