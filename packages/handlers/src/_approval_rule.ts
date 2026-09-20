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
import {
  getCapability,
  HandlerError,
  type CheckedContext,
} from "@oxagen/oxagen";
import { unionConsequenceTags } from "@oxagen/oxagen/contracts/tool.classification";
import {
  measureDeclarationsReadSchema,
  type MeasureDeclarations,
} from "@oxagen/oxagen/mandates/schemas";
import {
  MAX_AUTHORED_CONSEQUENCES,
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

/**
 * Take the row lock every rule write serialises on.
 *
 * The three writes are read-modify-write over one JSONB document: read the
 * clause, change one rule, store the whole array back. Without the lock two
 * operators who toggle DIFFERENT rules at the same time both read the same
 * original array and both store their own copy, and the second silently
 * undoes the first. That is worst for the one capability an operator reaches
 * for during an incident: switching a rule off, seeing it succeed, and having
 * a colleague's unrelated toggle switch it back on.
 *
 * Same idiom as the mandate ledger's `lockMandate`: `SELECT … FOR UPDATE` on
 * the row the document lives in, taken before the read, held to commit.
 */
export async function lockWorkspaceRuleSet(
  tx: Tx,
  workspaceId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .for("update");
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "workspace_not_found",
      message: "The workspace is not readable in this scope",
    });
  }
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
  // The document is parsed before it is stored, so no write can leave behind
  // one the gate cannot load. A stored set that does not parse takes the
  // workspace's whole rule set dark — the gate clause with it — and the only
  // repair is by hand, so the write is refused instead.
  try {
    parseRuleSet(next);
  } catch {
    throw new HandlerError({
      code: "conflict",
      reason: "rule_set_would_not_load",
      message:
        "The rule set this write would store does not parse; nothing was written",
    });
  }
  await tx
    .update(schema.workspaces)
    .set({
      settings: sql`jsonb_set(coalesce(${schema.workspaces.settings}, '{}'::jsonb), '{decisionRules}', ${JSON.stringify(next)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.workspaces.id, workspaceId));
  // Retained invalidation seam; decision reads no longer use a process cache.
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

/**
 * The rule with the provenance the handler records, ready to store.
 *
 * `authoredConsequences` is the effective tag set `assertRulesSavable` just
 * checked this rule against. It is stamped on every write that runs that gate,
 * so the rule and the accountability it was granted under stay together.
 */
export function stamp(
  body: AutoApprovalRuleBody,
  createdBy: string | null,
  at: Date,
  authoredConsequences: readonly string[] | undefined,
): AutoApprovalRule {
  return {
    ...body,
    disabledReason: undefined,
    createdBy,
    createdAt: at.toISOString(),
    authoredConsequences: authoredConsequences
      ? [...authoredConsequences]
      : undefined,
  };
}

interface DeclaredTool {
  slug: string;
  version: number;
  consequenceTags: string[];
  measures: MeasureDeclarations;
}

/**
 * Every enabled declared tool of the workspace, with its active version.
 *
 * `consequenceTags` is the EFFECTIVE union of the declared column and the
 * classified jsonb, through the one function every reader of this fact uses.
 * Reading only the column here was a real bypass, and a quiet one: a tool with
 * no declared consequences that `set_tool_classification` had marked
 * `moves_money` presented no tags to `assertRulesSavable`, so an Admin cleared
 * the handler's `{ org: ["Owner","Admin"] }` gate, never reached the
 * consequence gate that reserves money to Owner and Billing, and authored a
 * rule that `loadDeclaredTool` would then enforce against the very tag the
 * authoring gate never saw. The floor and the gate have to read one fact.
 */
async function declaredTools(
  tx: Tx,
  workspaceId: string,
): Promise<DeclaredTool[]> {
  const rows = await tx
    .select({
      slug: schema.tools.slug,
      version: schema.toolVersions.versionNumber,
      consequenceTags: schema.toolVersions.consequenceTags,
      classification: schema.toolVersions.classification,
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
    // Read-time schema (ADR-111): accepts a legacy non-ISO unit a version
    // published before the currency check landed can still carry on disk.
    const parsed = measureDeclarationsReadSchema.safeParse(r.measures);
    return {
      slug: r.slug,
      version: r.version,
      consequenceTags: unionConsequenceTags(r),
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
/** What a condition reads off the call: a value to compare, or a target to match. */
type ConditionKind = "value" | "target";

/** The measure kinds `readDeclaredMeasures` files under each of the two. */
const DECLARED_AS: Record<ConditionKind, readonly string[]> = {
  value: ["amount", "count"],
  target: ["text"],
};

/** Refuse a condition whose measure the tool does not declare, or declares as the other kind. */
function assertDeclaredAs(
  tool: DeclaredTool,
  measure: string,
  kind: ConditionKind,
): void {
  const declaration = tool.measures[measure];
  const at = `${tool.slug}@${tool.version}`;
  if (declaration === undefined) {
    throw new HandlerError({
      code: "conflict",
      reason: "measure_not_declared",
      message: `${at} declares no measure "${measure}" for the condition the rule names`,
    });
  }
  if (!DECLARED_AS[kind].includes(declaration.type)) {
    throw new HandlerError({
      code: "conflict",
      reason: "measure_wrong_type",
      message:
        kind === "value"
          ? `${at} declares "${measure}" as ${declaration.type}; a ceiling needs an amount or a count`
          : `${at} declares "${measure}" as ${declaration.type}; an allow list needs a text measure`,
    });
  }
}

/**
 * The effective consequence tags each rule was checked against, by rule id —
 * what `stamp` records so the evaluation can tell that a tool's consequences
 * grew under a rule that was already saved (`approvalRuleSchema`).
 */
export type AuthoredConsequences = ReadonlyMap<string, string[]>;

export async function assertRulesSavable(
  tx: Tx,
  ctx: Pick<CheckedContext, "orgId" | "workspaceId" | "userId" | "apiKeyId">,
  workspaceId: string,
  rules: readonly AutoApprovalRuleBody[],
): Promise<AuthoredConsequences> {
  const authored = new Map<string, string[]>();
  if (rules.length === 0) return authored;
  const declared = await declaredTools(tx, workspaceId);
  const overrides = await loadConsequenceRoles(tx, workspaceId);
  const tags = new Set<string>();

  for (const rule of rules) {
    // Per rule as well as across all of them: the role check needs every tag
    // any rule touches together, and the stamp needs each rule's own.
    const perRule = new Set<string>();
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
      // A rule can only govern a tool whose calls go through `invoke()`, which
      // is where the decision-rules gate runs. An external MCP tool is
      // dispatched by materialize-tools through `authorizeExternalCapability`
      // and the transport directly, so it is IAM-checked and kill-switched but
      // the gate never sees it — no `deny` rule, no `require_approval`, no
      // mandate check and no auto-approval clause.
      //
      // Refused rather than saved, and the deny case is why it matters more
      // than the auto-approval one: a rule set is the same document, so an
      // operator could write a DENY rule naming an MCP tool, watch it save,
      // see it listed as enabled, and be covered by nothing. Governance that
      // accepts a rule and silently declines to enforce it is worse than
      // governance that refuses it, because the operator believes they are
      // covered.
      //
      // The same test `publish_tool_declaration` already applies to a
      // classification (`conflict` / `consequence_not_gated`): the slug has to
      // name a registered capability.
      const ungated = matched.filter(
        (t) => getCapability(t.slug) === undefined,
      );
      if (ungated.length > 0) {
        const names = [...new Set(ungated.map((t) => t.slug))].sort();
        throw new HandlerError({
          code: "conflict",
          reason: "rule_not_gated",
          message: `Tool pattern "${pattern}" matches ${names.join(", ")}, which invoke() does not dispatch — the decision-rules gate never sees those calls, so a rule over them would be stored and never enforced`,
        });
      }
      for (const tool of matched) {
        // A ceiling is measured against a value, and an allow list is matched
        // against a target, so each condition needs its measure declared AND
        // declared as the right kind. `readDeclaredMeasures` files an amount
        // or a count as a value and text as a target; a ceiling over a text
        // measure, or an allow list over a numeric one, would read as
        // unreadable on every call and the rule would never fire. A rule that
        // saves cleanly and can never fire is worse than a refused one,
        // because nothing on the page says why.
        for (const measure of Object.keys(rule.maxMeasures)) {
          assertDeclaredAs(tool, measure, "value");
        }
        for (const measure of Object.keys(rule.allowTargets)) {
          assertDeclaredAs(tool, measure, "target");
        }
        for (const tag of tool.consequenceTags) {
          tags.add(tag);
          perRule.add(tag);
        }
      }
    }
    // The stamp is a STORED field with a bound, and the bound is reachable.
    // A version carries at most 16 declared tags (`publish_tool_declaration`)
    // and 32 classified ones (`toolClassificationSchema`), and the vocabulary
    // is open — `consequenceTagSchema` admits any snake_case string — so two
    // matched tools can already contribute 96 distinct tags and a `*` pattern
    // has no ceiling at all. There is no maximum to size the field for.
    //
    // Refused HERE rather than at the store. `writeRules` parses the document
    // before writing it, so an over-long stamp was already refused — as
    // `rule_set_would_not_load`, which names a document the author never
    // wrote, about a field the handler generated and the page does not show.
    // A rule the three guards above had just authorised, refused by a fact
    // about its own provenance stamp, with nothing telling the author what to
    // change. Named instead, in the shape `rule_not_gated` and
    // `measure_not_declared` use: what exceeded what, and the one thing that
    // fixes it.
    //
    // The breadth it refuses is worth refusing on its own account, which is
    // why this is a guard and not a bigger constant: one rule spanning more
    // than `MAX_AUTHORED_CONSEQUENCES` distinct consequences asks a single
    // author to be accountable for all of them at once, which is the widening
    // §6.9 part 2 exists to stop. Narrowing the patterns is the repair, and it
    // leaves each narrower rule with an author who can answer for it.
    if (perRule.size > MAX_AUTHORED_CONSEQUENCES) {
      throw new HandlerError({
        code: "conflict",
        reason: "too_many_consequences",
        message: `Rule "${rule.id}" matches tools carrying ${perRule.size} distinct consequences; at most ${MAX_AUTHORED_CONSEQUENCES} can be recorded against one rule, so narrow its tool patterns`,
      });
    }
    authored.set(rule.id, [...perRule].sort());
  }

  if (tags.size > 0) {
    await assertConsequenceRole(ctx, [...tags].sort(), overrides, tx);
  }
  return authored;
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

/**
 * The fields an author writes, in one canonical string, so two copies of a
 * rule compare equal whatever order their records' keys arrived in.
 * Provenance (`createdBy`, `createdAt`, `authoredConsequences`) is left out:
 * it is what a write stamps, not what an author changes.
 */
export function ruleBodyKey(rule: AutoApprovalRuleBody): string {
  const sorted = <T>(record: Readonly<Record<string, T>>) =>
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]] as const);
  return JSON.stringify([
    rule.id,
    rule.name,
    rule.tools,
    rule.enabled,
    sorted(rule.maxMeasures),
    sorted(rule.allowTargets),
    rule.standingWindowMs,
    rule.businessHours === null
      ? null
      : [
          rule.businessHours.timezone,
          rule.businessHours.days,
          rule.businessHours.start,
          rule.businessHours.end,
        ],
  ]);
}

/**
 * True when the stored rules are, rule for rule and in order, the bodies a
 * caller says it read. The optimistic check `set_approval_rules` makes when a
 * caller sends `replaces`.
 */
export function sameRuleBodies(
  stored: readonly AutoApprovalRuleBody[],
  read: readonly AutoApprovalRuleBody[],
): boolean {
  return (
    stored.length === read.length &&
    stored.every((rule, i) => ruleBodyKey(rule) === ruleBodyKey(read[i]!))
  );
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
