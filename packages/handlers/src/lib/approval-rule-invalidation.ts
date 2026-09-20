import { schema, type Tx } from "@oxagen/database";
import { emitSecurityEventIn } from "@oxagen/database/security";
import { isHandlerError } from "@oxagen/oxagen";
import type { AutoApprovalRule } from "@oxagen/oxagen/approval-rules/schemas";
import { unionConsequenceTags } from "@oxagen/oxagen/contracts/tool.classification";
import { toolMatches } from "@oxagen/rules";
import { eq } from "drizzle-orm";
import { assertRulesSavable, readRules, writeRules } from "../_approval_rule";
import { canonicalJson } from "../registry-digest";

export interface ApprovalToolFacts {
  slug: string;
  version: number;
  consequenceTags: readonly string[];
  classification: unknown;
  measures: unknown;
}

type DisabledReason = NonNullable<AutoApprovalRule["disabledReason"]>;

/** A new match or a changed measure needs the author's explicit review. */
export function changedRuleMeaning(
  rule: AutoApprovalRule,
  before: ApprovalToolFacts | null,
  after: ApprovalToolFacts,
): DisabledReason["code"] | null {
  if (!rule.enabled || !toolMatches(rule.tools, after.slug, after.version))
    return null;
  if (!before || !toolMatches(rule.tools, before.slug, before.version))
    return "tool_scope_changed";
  const oldMeasures = (before.measures ?? {}) as Record<string, unknown>;
  const newMeasures = (after.measures ?? {}) as Record<string, unknown>;
  const named = new Set([
    ...Object.keys(rule.maxMeasures),
    ...Object.keys(rule.allowTargets),
  ]);
  for (const name of named) {
    if (
      canonicalJson(oldMeasures[name] ?? null) !==
      canonicalJson(newMeasures[name] ?? null)
    )
      return "measure_changed";
  }
  return null;
}

export interface InvalidationArgs {
  orgId: string;
  workspaceId: string;
  actorUserId: string | null;
  capability: string;
  before: ApprovalToolFacts | null;
  after: ApprovalToolFacts;
}

/** The caller holds the workspace lock and has written the new tool facts. */
export async function invalidateApprovalRules(
  tx: Tx,
  args: InvalidationArgs,
): Promise<void> {
  const rules = await readRules(tx, args.workspaceId);
  const next: AutoApprovalRule[] = [];
  let changed = false;
  for (const rule of rules) {
    if (
      !rule.enabled ||
      !toolMatches(rule.tools, args.after.slug, args.after.version)
    ) {
      next.push(rule);
      continue;
    }
    let code = changedRuleMeaning(rule, args.before, args.after);
    let detail =
      code === "measure_changed"
        ? "A measure this rule uses changed. Review and save the rule before enabling it."
        : "A newly matching tool needs review. Save the rule before enabling it.";
    let authored: string[] | undefined;
    if (!code) {
      const [author] = rule.createdBy
        ? await tx
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.publicId, rule.createdBy))
            .limit(1)
        : [];
      if (!author) {
        code = "classification_changed";
        detail =
          "The rule's author cannot be resolved. Review and save the rule before enabling it.";
      } else {
        try {
          const checked = await assertRulesSavable(
            tx,
            {
              orgId: args.orgId,
              workspaceId: args.workspaceId,
              userId: author.id,
              apiKeyId: null,
            },
            args.workspaceId,
            [rule],
          );
          authored = checked.get(rule.id);
        } catch (error) {
          // Operational errors roll back the tool write; authorization refusals disable only the rule.
          if (
            !isHandlerError(error) ||
            !["forbidden", "conflict"].includes(error.code)
          )
            throw error;
          code = "classification_changed";
          detail =
            "The rule no longer passes its author's authority checks. Review and save it before enabling it.";
        }
      }
    }
    if (!code) {
      // Keep the author and date; only refresh the consequences the same author still covers.
      next.push({
        ...rule,
        authoredConsequences: authored ?? rule.authoredConsequences,
      });
      changed ||=
        canonicalJson(authored ?? null) !==
        canonicalJson(rule.authoredConsequences ?? null);
      continue;
    }
    const at = new Date();
    const disabledReason = {
      code,
      tool: `${args.after.slug}@${args.after.version}`,
      at: at.toISOString(),
      detail,
    };
    next.push({ ...rule, enabled: false, disabledReason });
    changed = true;
    await emitSecurityEventIn(tx, {
      eventType: "approval_rule.invalidated",
      actorUserId: args.actorUserId,
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      capability: args.capability,
      outcome: "success",
      occurredAt: at,
      ip: null,
      userAgent: null,
      requestId: null,
      detail: {
        ruleId: rule.id,
        tool: disabledReason.tool,
        reason: code,
        before: args.before
          ? {
              consequenceTags: unionConsequenceTags(args.before),
              measures: args.before.measures,
              classification: args.before.classification,
            }
          : null,
        after: {
          consequenceTags: unionConsequenceTags(args.after),
          measures: args.after.measures,
          classification: args.after.classification,
        },
      },
    });
  }
  if (changed) await writeRules(tx, args.workspaceId, next);
}
