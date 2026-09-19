"use server";
// The writes the Tools page makes (#2958; auto-approvals, ADR-070), each
// through the kernel seam for the workspace viewer the URL names.
//
// Every one is `noBillingGate` and role-checked in its handler (INV-29), so
// there is no second gate here: `import_tools` and `set_tool_classification`
// want an org Owner or Admin (import also accepts a workspace Owner),
// `set_kill_switch` an org Owner or Admin, and the three auto-approval writes
// an org Owner or Admin. A refusal comes back as `denied` with nothing
// changed, and the page names it where the person acted.
import { approvalRuleDelete } from "@oxagen/oxagen/contracts/approval_rule.delete";
import { approvalRuleEnabledSet } from "@oxagen/oxagen/contracts/approval_rule.enabled.set";
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { approvalRuleSet } from "@oxagen/oxagen/contracts/approval_rule.set";
import {
  killSwitchSet,
  type KillSwitchSetInput,
} from "@oxagen/oxagen/contracts/kill_switch.set";
import { toolClassificationSet } from "@oxagen/oxagen/contracts/tool.classification.set";
import { toolImport } from "@oxagen/oxagen/contracts/tool.import";
import type {
  ApprovalRuleHours,
  KillSwitchKind,
  ToolClassification,
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
} from "@/data/contracts/tools";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import {
  kernelRead,
  kernelWrite,
  readToActionResult,
} from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/**
 * Pulls a registered MCP server's pinned tools into the registry: one
 * immutable version per changed manifest, idempotent on an unchanged one.
 * `tools` empty imports every pin the server has.
 */
export async function importTools(
  org: string,
  ws: string,
  draft: { serverId: string; tools: readonly string[] },
): Promise<
  ActionResult<{
    importDigest: string;
    published: number;
    unchanged: number;
  }>
> {
  const ctx = await requireViewer(org, ws);
  const picked = draft.tools.map((name) => name.trim()).filter((n) => n !== "");
  const result = await kernelWrite(ctx, toolImport, {
    serverId: draft.serverId.trim(),
    ...(picked.length === 0 ? {} : { tools: picked }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          importDigest: result.value.importDigest,
          published: result.value.tools.filter((t) => t.published).length,
          unchanged: result.value.tools.filter((t) => !t.published).length,
        },
      }
    : result;
}

export type ClassificationDraft = {
  toolVersionId: string;
  riskGrade: ToolRiskGrade;
  sideEffect: ToolSideEffect;
  egress: ToolEgress;
  /** One tag per entry, already split; the handler refuses a repeat. */
  consequenceTags: readonly string[];
  dataClasses: readonly string[];
  /** The version's measures, carried through unchanged: this page does not author a JSONPath. */
  measures: ToolClassification["measures"];
  reason: string;
};

/**
 * Sets a tool version's safety classification. Classification describes the
 * tool; a class kill switch and the approval rules decide against it.
 */
export async function setToolClassification(
  org: string,
  ws: string,
  draft: ClassificationDraft,
): Promise<ActionResult<{ classifiedAt: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, toolClassificationSet, {
    toolVersionId: draft.toolVersionId,
    riskGrade: draft.riskGrade,
    classification: {
      sideEffect: draft.sideEffect,
      egress: draft.egress,
      consequenceTags: [...draft.consequenceTags],
      dataClasses: [...draft.dataClasses],
      measures: Object.fromEntries(
        draft.measures.map((measure) => [
          measure.name,
          {
            path: measure.path,
            type: measure.type,
            ...(measure.currencyPath === null
              ? {}
              : { currencyPath: measure.currencyPath }),
            ...(measure.unit === null ? {} : { unit: measure.unit }),
          },
        ]),
      ),
    },
    reason: draft.reason.trim(),
  });
  return result.ok
    ? { ok: true, value: { classifiedAt: result.value.classifiedAt } }
    : result;
}

/**
 * The flip's target, with its kind as a literal: the contract's target is a
 * discriminated union, so the kind has to be narrowed before it is carried.
 */
function targetOf(
  kind: KillSwitchKind,
  id: string,
): KillSwitchSetInput["target"] {
  switch (kind) {
    case "tool_version":
      return { kind, id };
    case "tool_server":
      return { kind, id };
    case "connection":
      return { kind, id };
    case "agent":
      return { kind, id };
    case "operator":
      return { kind, id };
    case "workspace":
      return { kind, id };
    case "org":
      return { kind, id };
    case "class":
      return { kind, id };
  }
}

/**
 * The id the flip names.
 *
 * The dialog sends null at the organization and workspace levels, where it
 * asked for no target: the contract wants the tenant's database uuid there and
 * the page never prints a uuid (INV-11), so the viewer the URL named is the
 * one answer — without it those two switches, the broadest denies on the
 * board, could not be flipped at all, because a person typing the slug they
 * can see is refused by `killSwitchTargetSchema`.
 *
 * A card always sends the id its switch was recorded against, including at
 * those two levels, so a workspace switch recorded against another workspace
 * is cleared against that workspace and not against this one. At every other
 * level the dialog asked, and a null there is an id the caller did not supply:
 * the empty string the contract refuses, which comes back as `invalid`.
 */
function targetIdOf(
  kind: KillSwitchKind,
  typed: string | null,
  tenant: { orgId: string; workspaceId: string },
): string {
  if (typed !== null) return typed.trim();
  switch (kind) {
    case "org":
      return tenant.orgId;
    case "workspace":
      return tenant.workspaceId;
    default:
      return "";
  }
}

/**
 * Flips a kill switch on or off. It takes effect at the next call boundary by
 * bumping the deny generation in the same transaction; a connection switch
 * revokes its live credential grants.
 */
export async function flipKillSwitch(
  org: string,
  ws: string,
  flip: {
    kind: KillSwitchKind;
    /** Null at a level whose target is the tenant in view; see `targetIdOf`. */
    target: string | null;
    on: boolean;
    reason: string;
  },
): Promise<
  ActionResult<{
    switchId: string;
    on: boolean;
    changed: boolean;
    denyGeneration: { org: number; workspace: number };
    grantsRevoked: number;
  }>
> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, killSwitchSet, {
    target: targetOf(flip.kind, targetIdOf(flip.kind, flip.target, ctx)),
    on: flip.on,
    reason: flip.reason.trim(),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          switchId: result.value.switchId,
          on: result.value.on,
          changed: result.value.changed,
          denyGeneration: result.value.denyGeneration,
          grantsRevoked: result.value.grantsRevoked,
        },
      }
    : result;
}

/** One auto-approval rule as the dialog writes it: the fields an author owns. */
export type ApprovalRuleDraft = {
  id: string;
  name: string;
  /** One glob per entry, already split. */
  tools: readonly string[];
  enabled: boolean;
  /** measure → the inclusive ceiling, an integer string. */
  maxMeasures: Readonly<Record<string, string>>;
  /** measure → the globs its target must match. */
  allowTargets: Readonly<Record<string, readonly string[]>>;
  standingWindowMs: number | null;
  businessHours: ApprovalRuleHours | null;
};

type StoredRule = ContractOutput<typeof approvalRuleList>["items"][number];

/**
 * A stored rule as the body `set_approval_rules` takes back. The provenance
 * (`createdBy`, `createdAt`, `authoredConsequences`) and the two counters are
 * the handler's, so they are left off and the handler re-derives them.
 */
function bodyOf(rule: StoredRule | ApprovalRuleDraft) {
  return {
    id: rule.id,
    name: rule.name,
    tools: [...rule.tools],
    enabled: rule.enabled,
    maxMeasures: { ...rule.maxMeasures },
    allowTargets: Object.fromEntries(
      Object.entries(rule.allowTargets).map(([measure, globs]) => [
        measure,
        [...globs],
      ]),
    ),
    standingWindowMs: rule.standingWindowMs,
    businessHours:
      rule.businessHours === null
        ? null
        : {
            timezone: rule.businessHours.timezone,
            days: [...rule.businessHours.days],
            start: rule.businessHours.start,
            end: rule.businessHours.end,
          },
  };
}

/**
 * One rule body as a string two equal bodies share: the record fields are
 * written in key order, because two reads of the same rule may order them
 * differently and that is not a change anyone made.
 */
function bodyKey(body: ReturnType<typeof bodyOf>): string {
  const ordered = <T,>(record: Readonly<Record<string, T>>) =>
    Object.fromEntries(
      Object.entries(record).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  return JSON.stringify({
    ...body,
    maxMeasures: ordered(body.maxMeasures),
    allowTargets: ordered(body.allowTargets),
  });
}

/**
 * Creates or edits one auto-approval rule.
 *
 * `set_approval_rules` replaces the whole set, so this reads the set as it is
 * now and splices the one rule into it, rather than trusting the copy the page
 * rendered. A page loaded before another person's edit would otherwise write
 * that edit away. Two windows are open between the page and the write, and
 * each is closed separately:
 *
 * - **render to read.** The dialog opens on a rule it rendered and submits
 *   whenever the author is done, so `rendered` carries the rule as they saw
 *   it and an edit is refused as `rule_changed` when the read no longer
 *   matches it. Without it, another person switching the rule off is undone
 *   by a stale editor still carrying `enabled: true`.
 * - **read to write.** The read goes back as `replaces`, and the handler
 *   compares it with the stored set under its rule-set lock, refusing as
 *   `rule_set_changed` when they differ.
 *
 * Rules this save does not change keep their stamp on the server.
 *
 * A rule's id is its audit citation (`policy:<id>`), so an edit keeps it and
 * a create refuses an id already in use rather than overwriting that rule.
 */
export async function saveApprovalRule(
  org: string,
  ws: string,
  mode: "create" | "edit",
  draft: ApprovalRuleDraft,
  /**
   * The rule as the editor rendered it, and null when creating: a create
   * writes over nothing, and the id check below refuses one already in use.
   */
  rendered: ApprovalRuleDraft | null,
): Promise<ActionResult<{ ruleId: string }>> {
  const ctx = await requireViewer(org, ws);
  const current = await kernelRead(ctx, {
    contract: approvalRuleList,
    input: {},
    page: "tools",
  });
  if (!current.ok) return readToActionResult<never>(current);
  const stored = current.value.items;
  const body = bodyOf({
    ...draft,
    id: draft.id.trim(),
    name: draft.name.trim(),
    tools: draft.tools.map((glob) => glob.trim()).filter((g) => g !== ""),
  });
  const before = stored.find((rule) => rule.id === body.id);
  if (mode === "create" && before !== undefined) {
    return { ok: false, reason: "conflict", code: "rule_id_taken" };
  }
  if (mode === "edit") {
    if (before === undefined) {
      return {
        ok: false,
        reason: "not_found",
        code: "approval_rule_not_found",
      };
    }
    if (
      rendered === null ||
      bodyKey(bodyOf(rendered)) !== bodyKey(bodyOf(before))
    ) {
      return { ok: false, reason: "conflict", code: "rule_changed" };
    }
  }
  const rules =
    mode === "create"
      ? [...stored.map(bodyOf), body]
      : stored.map((rule) => (rule.id === body.id ? body : bodyOf(rule)));
  // `replaces` makes the write conditional on the set read above: if another
  // person deleted, switched off or edited a rule in between, the handler
  // refuses it as `rule_set_changed` instead of writing their change away.
  const result = await kernelWrite(ctx, approvalRuleSet, {
    rules,
    replaces: stored.map(bodyOf),
    // The rule being saved is re-checked and re-stamped even if unchanged, so
    // saving a rule held back as `consequences_changed` re-authorises it.
    saving: [body.id],
  });
  return result.ok ? { ok: true, value: { ruleId: body.id } } : result;
}

/**
 * Switches one rule on or off without sending the rest of the set back.
 * Switching on re-runs the checks the rule was saved under.
 */
export async function setApprovalRuleEnabled(
  org: string,
  ws: string,
  ruleId: string,
  enabled: boolean,
): Promise<ActionResult<{ ruleId: string; enabled: boolean }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, approvalRuleEnabledSet, {
    ruleId,
    enabled,
  });
  return result.ok ? { ok: true, value: { ruleId, enabled } } : result;
}

/** Removes one rule from the set. Switching it off keeps its id and counters instead. */
export async function deleteApprovalRule(
  org: string,
  ws: string,
  ruleId: string,
): Promise<ActionResult<{ ruleId: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, approvalRuleDelete, { ruleId });
  return result.ok ? { ok: true, value: { ruleId } } : result;
}
