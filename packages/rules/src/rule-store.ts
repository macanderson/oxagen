/**
 * Where a workspace's rule set lives, and the cache in front of it.
 *
 * `workspaces.settings.decisionRules` — the workspace settings JSONB. Both
 * clauses of the document live here (ADR-070 decision 2): the gate rules that
 * were already stored here, and the auto-approval rules `set_approval_rules`
 * writes. One store, one loader, one read on the decision path. The loader
 * shape stays the seam: moving the document to a versioned registry record is
 * a change to these two functions and to nothing that calls them.
 *
 * ## The cache
 *
 * The gate fires on every scoped `invoke()`, and a per-invoke row read would
 * put the settings table on the hot path of every tool call. Rules change at
 * human speed; a 30-second TTL bounds staleness to less than any human
 * authoring loop while cutting the read amplification to one per workspace
 * per window. Negative results are cached too — most workspaces have no
 * rules, and those must not pay the read either. A write through one of the
 * approval-rule capabilities drops its workspace's entry, so the process that
 * made the change sees it at once.
 *
 * This module holds no dependency on the mandate check or the gate, so the
 * mandate check can read the rule set inside its own transaction without an
 * import cycle.
 */
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { ruleSetSchema } from "./schema";
import type { RuleSet } from "./types";

/** MEASURED-free tuning constant: staleness ceiling for a published rule change. */
const RULES_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  at: number;
  ruleSet: RuleSet | null;
}

const cache = new Map<string, CacheEntry>();

/** Drop the cache: a test seam, and what a rule write calls for its own workspace. */
export function clearDecisionRulesCache(workspaceId?: string): void {
  if (workspaceId === undefined) cache.clear();
  else cache.delete(workspaceId);
}

/**
 * Parse one stored settings bag.
 *
 * Malformed rules load as `null` with a LOUD log rather than an error: a
 * workspace whose stored governance no longer parses must degrade to
 * ungoverned-with-alarm, not to every agent action failing.
 */
function parseStored(workspaceId: string, settings: unknown): RuleSet | null {
  const raw = (settings as Record<string, unknown> | null | undefined)
    ?.decisionRules;
  if (raw === undefined || raw === null) return null;
  const parsed = ruleSetSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logger.error(
    { workspaceId, issues: parsed.error.issues },
    "decision rules: stored settings.decisionRules does not parse — workspace is running UNGOVERNED until it is fixed",
  );
  return null;
}

/** The rule set of one workspace inside the caller's transaction, through the cache. */
export async function loadRuleSetIn(
  tx: Tx,
  workspaceId: string,
): Promise<RuleSet | null> {
  const cached = cache.get(workspaceId);
  if (cached && Date.now() - cached.at < RULES_CACHE_TTL_MS) {
    return cached.ruleSet;
  }
  const row = await tx.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, workspaceId),
    columns: { settings: true },
  });
  const ruleSet = parseStored(workspaceId, row?.settings);
  cache.set(workspaceId, { at: Date.now(), ruleSet });
  return ruleSet;
}

/** The rule set of one workspace, in its own transaction. The gate's loader. */
export async function loadWorkspaceRuleSet(args: {
  orgId: string;
  workspaceId: string | null;
}): Promise<RuleSet | null> {
  const { workspaceId } = args;
  if (!workspaceId) return null;
  const cached = cache.get(workspaceId);
  if (cached && Date.now() - cached.at < RULES_CACHE_TTL_MS) {
    return cached.ruleSet;
  }
  return withTenantDb((tx) => loadRuleSetIn(tx, workspaceId));
}

/** Read current authority without either cache; missing or malformed workspaces refuse admission. */
export async function loadCurrentRuleSet(args: {
  orgId: string;
  workspaceId: string | null;
}): Promise<RuleSet | null> {
  const workspaceId = args.workspaceId;
  if (!workspaceId) throw new Error("Current rules require a workspace");
  return withTenantDb(async (tx) => {
    const row = await tx.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.orgId, args.orgId),
      ),
      columns: { settings: true },
    });
    if (!row) throw new Error("Current rule workspace is unavailable");
    const raw = (row.settings as Record<string, unknown> | null)?.decisionRules;
    return raw == null ? null : ruleSetSchema.parse(raw);
  });
}

export const loadExternalRuleSet = loadCurrentRuleSet;
