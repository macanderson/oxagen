// Shared pieces of the auto-approval rule handlers (MC spec §6.9 part 2,
// ADR-070): where the clause is stored, the guards a rule must clear before it
// is saved, and the 30-day counters every read returns beside it.
//
// The rules are the second clause of the rule set the decision gate already
// loads, stored in `workspace.workspaces.settings.decisionRules` (ADR-070
// decision 2). One store, one loader, one read on the decision path. Every
// write goes through `writeRules`, which touches that one key of the settings
// bag and leaves every sibling key alone.

import { schema, type Tx } from "@oxagen/database";
import {
  assertConsequenceRole,
  loadConsequenceRoles,
} from "@oxagen/iam/mandate-role";
import { HandlerError, type CheckedContext } from "@oxagen/oxagen";
import {
  measureDeclarationsSchema,
  type MeasureDeclarations,
} from "@oxagen/oxagen/mandates/schemas";
import {
  RULE_SET_SCHEMA_V2,
  type AutoApprovalRule,
  type AutoApprovalRuleBody,
} from "@oxagen/oxagen/approval-rules/schemas";
import type { ApprovalRuleListOutput } from "@oxagen/oxagen/contracts/approval_rule.list";
import {
  clearDecisionRulesCache,
  parseRuleSet,
  toolMatches,
} from "@oxagen/rules";
import { and, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";

/** The window the hit and held counters are measured over. */
export const COUNTER_WINDOW_DAYS = 30;

export function requireWorkspace(ctx: CheckedContext, name: string): string {
  if (!ctx.workspaceId) {
    throw new Error(`[${name}] workspaceId is required (scoped capability)`);
  }
  return ctx.workspaceId;
}

/** The stored rule set of a workspace, or null when it has none. */
async function readStoredSet(
  tx: Tx,
  workspaceId: string,
): Promise<{ raw: unknown }> {
  const row = await tx.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, workspaceId),
    columns: { settings: true },
  });
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "workspace_not_found",
      message: "The workspace is not readable in this scope",
    });
  }
  return {
    raw: (row.settings as Record<string, unknown> | null)?.decisionRules,
  };
}

/**
 * The workspace's auto-approval rules as stored.
 *
 * A rule set that no longer parses reads as no rules, the same posture the
 * gate takes: a workspace whose stored governance is broken is ungoverned and
 * loud, never an error page on the Tools screen. The gate logs it; this read
 * shows an empty list, which is what the decision path is doing.
 */
export async function readRules(
  tx: Tx,
  workspaceId: string,
): Promise<AutoApprovalRule[]> {
  const { raw } = await readStoredSet(tx, workspaceId);
  if (raw === undefined || raw === null) return [];
  try {
    return parseRuleSet(raw).autoApproval ?? [];
  } catch {
    return [];
  }
}

/**
 * Replace the auto-approval clause in place.
 *
 * `jsonb_set` on the one key, so a concurrent write of any other settings key
 * is not clobbered, and the gate clause beside it is carried through
 * unchanged. The discriminator moves to v2 the first time a clause is written;
 * a set that never carries one stays readable as v1.
 */
export async function writeRules(
  tx: Tx,
  workspaceId: string,
  rules: AutoApprovalRule[],
): Promise<void> {
  const { raw } = await readStoredSet(tx, workspaceId);
  const existing =
    raw === undefined || raw === null
      ? { schema: RULE_SET_SCHEMA_V2, rules: [] }
      : (raw as Record<string, unknown>);
  const next = {
    ...existing,
    schema: RULE_SET_SCHEMA_V2,
    rules: Array.isArray(existing.rules) ? existing.rules : [],
    autoApproval: rules,
  };
  await tx
    .update(schema.workspaces)
    .set({
      settings: sql`jsonb_set(coalesce(${schema.workspaces.settings}, '{}'::jsonb), '{decisionRules}', ${JSON.stringify(next)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.workspaces.id, workspaceId));
  // The loader caches for 30 seconds; the process that made the change sees it
  // at once, and every other process inside that window.
  clearDecisionRulesCache(workspaceId);
}

/** The public id (`usr_…`) of the user a rule records as its author. */
export async function publicUserId(
  tx: Tx,
  userId: string | null,
): Promise<string | null> {
  if (userId === null) return null;
  const [row] = await tx
    .select({ publicId: schema.users.publicId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row?.publicId ?? null;
}

/** The rule with the provenance the handler records, ready to store. */
export function stamp(
  body: AutoApprovalRuleBody,
  createdBy: string | null,
  at: Date,
): AutoApprovalRule {
  return { ...body, createdBy, createdAt: at.toISOString() };
}

interface DeclaredTool {
  slug: string;
  version: number;
  consequenceTags: string[];
  measures: MeasureDeclarations;
}

/** Every enabled declared tool of the workspace, with its active version. */
async function declaredTools(
  tx: Tx,
  workspaceId: string,
): Promise<DeclaredTool[]> {
  const rows = await tx
    .select({
      slug: schema.tools.slug,
      version: schema.toolVersions.versionNumber,
      consequenceTags: schema.toolVersions.consequenceTags,
      measures: schema.toolVersions.measures,
    })
    .from(schema.tools)
    .innerJoin(
      schema.toolVersions,
      eq(schema.toolVersions.id, schema.tools.activeVersionId),
    )
    .where(
      and(
        eq(schema.tools.workspaceId, workspaceId),
        eq(schema.tools.enabled, true),
        isNull(schema.tools.deletedAt),
      ),
    );
  return rows.map((r) => {
    const parsed = measureDeclarationsSchema.safeParse(r.measures);
    return {
      slug: r.slug,
      version: r.version,
      consequenceTags: r.consequenceTags,
      measures: parsed.success ? parsed.data : {},
    };
  });
}

/**
 * The three guards a rule clears before it is stored.
 *
 * 1. Every tool pattern matches at least one declared, enabled tool. A rule
 *    over a tool nobody declared governs nothing and carries no safety
 *    classification for the floors to read.
 * 2. Every measure the rule caps or allow-lists is declared by every tool it
 *    matches — denied by construction, the same rule a mandate's limits clear
 *    (§6.9 rule 1). A ceiling over a measure the call does not carry would
 *    read as `measure_unreadable` at every decision.
 * 3. The caller holds an org role the workspace names for every consequence
 *    the matched tools carry. This is §6.9 part 2's "a rule cannot be saved
 *    that would widen an agent past its operator's grants": whoever may not
 *    grant authority over a consequence may not write the rule that lets a
 *    call carrying it skip a person either.
 */
export async function assertRulesSavable(
  tx: Tx,
  ctx: CheckedContext,
  workspaceId: string,
  rules: readonly AutoApprovalRuleBody[],
): Promise<void> {
  if (rules.length === 0) return;
  const declared = await declaredTools(tx, workspaceId);
  const overrides = await loadConsequenceRoles(tx, workspaceId);
  const tags = new Set<string>();

  for (const rule of rules) {
    for (const pattern of rule.tools) {
      const matched = declared.filter((t) =>
        toolMatches([pattern], t.slug, t.version),
      );
      if (matched.length === 0) {
        throw new HandlerError({
          code: "conflict",
          reason: "no_tool_matches",
          message: `Tool pattern "${pattern}" matches no declared tool in this workspace`,
        });
      }
      for (const tool of matched) {
        for (const measure of [
          ...Object.keys(rule.maxMeasures),
          ...Object.keys(rule.allowTargets),
        ]) {
          if (tool.measures[measure] === undefined) {
            throw new HandlerError({
              code: "conflict",
              reason: "measure_not_declared",
              message: `${tool.slug}@${tool.version} declares no measure "${measure}" for the condition the rule names`,
            });
          }
        }
        for (const tag of tool.consequenceTags) tags.add(tag);
      }
    }
  }

  if (tags.size > 0) {
    await assertConsequenceRole(ctx, [...tags].sort(), overrides);
  }
}

/**
 * The rules with what each one did in the window: `hits30d` counts the calls
 * it released with no person, `skipped30d` the calls it was read against and
 * did not release.
 *
 * Counted from the approval rows themselves rather than from a rollup. The
 * figure is the record, so there is nothing to rebuild nightly and nothing
 * that can be stale.
 */
export async function withCounters(
  tx: Tx,
  workspaceId: string,
  rules: readonly AutoApprovalRule[],
  now: Date = new Date(),
): Promise<ApprovalRuleListOutput> {
  const since = new Date(
    now.getTime() - COUNTER_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const ar = schema.approvalRequests;
  const counted =
    rules.length === 0
      ? []
      : await tx
          .select({
            ruleId: ar.autoRuleId,
            hits: sql<string>`count(*) filter (where ${ar.resolvedByPolicy} is not null)::text`,
            skipped: sql<string>`count(*) filter (where ${ar.resolvedByPolicy} is null)::text`,
          })
          .from(ar)
          .where(
            and(
              eq(ar.workspaceId, workspaceId),
              isNotNull(ar.autoRuleId),
              gte(ar.createdAt, since),
            ),
          )
          .groupBy(ar.autoRuleId);
  const by = new Map(counted.map((r) => [r.ruleId, r]));
  return {
    items: rules.map((rule) => ({
      ...rule,
      hits30d: Number(by.get(rule.id)?.hits ?? "0"),
      skipped30d: Number(by.get(rule.id)?.skipped ?? "0"),
    })),
    windowDays: COUNTER_WINDOW_DAYS,
  };
}

/** The rule `ruleId` names, or a `not_found` refusal. */
export function requireRule(
  rules: readonly AutoApprovalRule[],
  ruleId: string,
): AutoApprovalRule {
  const rule = rules.find((r) => r.id === ruleId);
  if (rule === undefined) {
    throw new HandlerError({
      code: "not_found",
      reason: "approval_rule_not_found",
      message: `No auto-approval rule ${ruleId} in this workspace`,
    });
  }
  return rule;
}
