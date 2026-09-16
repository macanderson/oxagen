"use server";
// The three writes the Tools page makes (#2958), each through the kernel seam
// for the workspace viewer the URL names.
//
// Every one is `noBillingGate` and role-checked in its handler (INV-29), so
// there is no second gate here: `import_tools` and `set_tool_classification`
// want an org Owner or Admin (import also accepts a workspace Owner),
// `set_kill_switch` an org Owner or Admin. A refusal comes back as `denied`
// with nothing changed, and the page names it where the person acted.
import {
  killSwitchSet,
  type KillSwitchSetInput,
} from "@oxagen/oxagen/contracts/kill_switch.set";
import { toolClassificationSet } from "@oxagen/oxagen/contracts/tool.classification.set";
import { toolImport } from "@oxagen/oxagen/contracts/tool.import";
import type {
  KillSwitchKind,
  ToolClassification,
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
} from "@/data/contracts/tools";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
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
