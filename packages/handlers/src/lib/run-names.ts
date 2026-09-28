import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import type { RunScope } from "../run.list";
import { readRunEnrichmentEnabled } from "./run-enrichment";
import { runLabel, tachoRunName } from "./run-item";

/**
 * The session name of each run in `runIds`, keyed by its public id, for a
 * page that cites runs by id (#4571). A run with no name, or one outside the
 * scope, maps to null, so the page falls back to "Untitled session".
 *
 * The name follows the Fleet board's rule. With automatic accounts on, a
 * wrapped session reads its harness title, then the generated name, then the
 * prompt title, and a ledger run reads its generated name. With them off, a
 * wrapped session keeps only its harness title and a ledger run has none.
 */
export async function readRunNames(
  scope: RunScope,
  runIds: readonly string[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(runIds)];
  const tachoIds = ids.filter((id) => id.startsWith("tse_"));
  const ledgerIds = ids.filter((id) => id.startsWith("arun_"));
  const names = new Map<string, string | null>(ids.map((id) => [id, null]));
  if (tachoIds.length === 0 && ledgerIds.length === 0) return names;
  const [enabled, sessions, runs] = await Promise.all([
    readRunEnrichmentEnabled(scope),
    tachoIds.length === 0 ? [] : readSessionTitles(scope, tachoIds),
    ledgerIds.length === 0 ? [] : readLedgerNames(scope, ledgerIds),
  ]);
  for (const s of sessions)
    names.set(
      s.publicId,
      enabled ? tachoRunName(s) : runLabel(s.harnessTitle),
    );
  for (const r of runs)
    names.set(r.publicId, enabled ? runLabel(r.name) : null);
  return names;
}

function readSessionTitles(scope: RunScope, publicIds: string[]) {
  const sessions = schema.tachoSessions;
  return withTenantDb((tx) =>
    tx
      .select({
        publicId: sessions.publicId,
        harnessTitle: sessions.harnessTitle,
        name: sessions.name,
        title: sessions.title,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.orgId, scope.orgId),
          eq(sessions.workspaceId, scope.workspaceId),
          inArray(sessions.publicId, publicIds),
        ),
      ),
  );
}

function readLedgerNames(scope: RunScope, publicIds: string[]) {
  const runs = schema.agentRuns;
  return withTenantDb((tx) =>
    tx
      .select({ publicId: runs.publicId, name: runs.name })
      .from(runs)
      .where(
        and(
          eq(runs.orgId, scope.orgId),
          eq(runs.workspaceId, scope.workspaceId),
          inArray(runs.publicId, publicIds),
        ),
      ),
  );
}
