/**
 * bootstrap.ts — wire the decision-rules gate into the AI kernel.
 *
 * The kernel refuses to import `@oxagen/rules` directly (same vendor-neutral,
 * no-cycle rule as billing), so it exposes an injection slot. Every service
 * surface that runs agent actions — api, app, mcp, the durable-run worker —
 * calls `bootstrapDecisionRulesRuntime()` once at startup, the same pattern as
 * `bootstrapBillingRuntime()`. Without the call the gate is dormant and every
 * capability proceeds exactly as before rules existed.
 *
 * ## Where the rules live (v1)
 *
 * `workspaces.settings.decisionRules` — the workspace settings JSONB, written
 * through the existing `workspace.settings.write` capability's atomic merge.
 * Chosen over a new table so governance is authorable TODAY with zero
 * migration; the workspace agent-asset registry (context records + versions +
 * promotion ledger) is where rule sets move once it lands, gaining immutable
 * versions and an approval chain. The loader shape is the seam: swapping the
 * storage is one function, not a gate change.
 *
 * ## The cache
 *
 * The gate fires on every scoped `invoke()`, and a per-invoke row read would
 * put the settings table on the hot path of every tool call. Rules change at
 * human speed; a 30-second TTL bounds staleness to less than any human
 * authoring loop while cutting the read amplification to one per workspace
 * per window. Negative results are cached too — most workspaces have no
 * rules, and those must not pay the read either.
 */
import { schema, withTenantDb } from "@oxagen/database";
import { setDecisionRulesGate } from "@oxagen/oxagen/kernel";
import { eq } from "drizzle-orm";
import { createDecisionRulesGate } from "./gate";
import { ruleSetSchema } from "./schema";
import type { RuleSet } from "./types";
import { logger } from "./logger";

/** MEASURED-free tuning constant: staleness ceiling for a published rule change. */
const RULES_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  at: number;
  ruleSet: RuleSet | null;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: drop the cache so a test can observe a fresh load. */
export function clearDecisionRulesCache(): void {
  cache.clear();
}

/**
 * Load a workspace's rule set from its settings bag.
 *
 * Malformed rules load as `null` with a LOUD log rather than an error:
 * `workspace.settings.write` is a generic merge with no schema for this key
 * yet, and a workspace whose stored governance no longer parses must degrade
 * to ungoverned-with-alarm, not to every agent action failing. Publish-time
 * validation arrives with the registry's dedicated publish capability.
 */
export async function loadWorkspaceRuleSet(args: {
  orgId: string;
  workspaceId: string | null;
}): Promise<RuleSet | null> {
  if (!args.workspaceId) return null;
  const cached = cache.get(args.workspaceId);
  if (cached && Date.now() - cached.at < RULES_CACHE_TTL_MS) {
    return cached.ruleSet;
  }

  const row = await withTenantDb((tx) =>
    tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, args.workspaceId!),
      columns: { settings: true },
    }),
  );
  const raw = (row?.settings as Record<string, unknown> | null | undefined)
    ?.decisionRules;

  let ruleSet: RuleSet | null = null;
  if (raw !== undefined && raw !== null) {
    const parsed = ruleSetSchema.safeParse(raw);
    if (parsed.success) {
      ruleSet = parsed.data;
    } else {
      logger.error(
        { workspaceId: args.workspaceId, issues: parsed.error.issues },
        "decision rules: stored settings.decisionRules does not parse — workspace is running UNGOVERNED until it is fixed",
      );
    }
  }
  cache.set(args.workspaceId, { at: Date.now(), ruleSet });
  return ruleSet;
}

let booted = false;

export function bootstrapDecisionRulesRuntime(): void {
  if (booted) return;
  booted = true;
  setDecisionRulesGate(
    createDecisionRulesGate({
      loadRuleSet: loadWorkspaceRuleSet,
      // No fact resolver yet: rules over `facts.…` keys parse and load, and
      // their leaves read an absent bag until the aggregate resolver lands
      // with the registry work. Rules over `input.…` and `call.…` bind fully.
      onError: (error) => {
        logger.warn(
          { err: error },
          "decision rules: gate infrastructure failure — failing open",
        );
      },
    }),
  );
  logger.info({}, "rules: decision gate wired into kernel.invoke()");
}
