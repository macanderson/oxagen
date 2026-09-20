/** Load committed workspace rules without process-local authorization caches. */
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { ruleSetSchema } from "./schema";
import type { RuleSet } from "./types";

/** Retained for callers that invalidate after writes; reads are now uncached. */
export function clearDecisionRulesCache(_workspaceId?: string): void {}

/** Serialize decision facts with tool and rule writers until the transaction ends. */
export async function lockDecisionRulesIn(
  tx: Tx,
  workspaceId: string,
): Promise<void> {
  await tx
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .for("share");
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

/** The rule set of one workspace inside the caller's transaction, without a process cache. */
export async function loadRuleSetIn(
  tx: Tx,
  workspaceId: string,
): Promise<RuleSet | null> {
  const row = await tx.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, workspaceId),
    columns: { settings: true },
  });
  const ruleSet = parseStored(workspaceId, row?.settings);
  return ruleSet;
}

/** The rule set of one workspace, in its own transaction. The gate's loader. */
export async function loadWorkspaceRuleSet(args: {
  orgId: string;
  workspaceId: string | null;
}): Promise<RuleSet | null> {
  const { workspaceId } = args;
  if (!workspaceId) return null;
  return withTenantDb((tx) => loadRuleSetIn(tx, workspaceId));
}

/** External transports have no fallback governance path, so invalid rules refuse the call. */
export async function loadExternalRuleSet(args: {
  orgId: string;
  workspaceId: string | null;
}): Promise<RuleSet | null> {
  const workspaceId = args.workspaceId;
  if (!workspaceId) throw new Error("External rules require a workspace");
  return withTenantDb(async (tx) => {
    const row = await tx.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.orgId, args.orgId),
      ),
      columns: { settings: true },
    });
    if (!row) throw new Error("External rule workspace is unavailable");
    const raw = (row.settings as Record<string, unknown> | null)?.decisionRules;
    return raw == null ? null : ruleSetSchema.parse(raw);
  });
}
