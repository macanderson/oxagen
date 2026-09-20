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
import { agentMcpRegister } from "@oxagen/oxagen/contracts/agent.mcp.register";
import { approvalRuleDelete } from "@oxagen/oxagen/contracts/approval_rule.delete";
import { approvalRuleEnabledSet } from "@oxagen/oxagen/contracts/approval_rule.enabled.set";
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { approvalRuleSet } from "@oxagen/oxagen/contracts/approval_rule.set";
import {
  killSwitchSet,
  type KillSwitchSetInput,
} from "@oxagen/oxagen/contracts/kill_switch.set";
import { connectionCreate } from "@oxagen/oxagen/contracts/connection.create";
import { connectionGet } from "@oxagen/oxagen/contracts/connection.get";
import { toolClassificationSet } from "@oxagen/oxagen/contracts/tool.classification.set";
import { toolImport } from "@oxagen/oxagen/contracts/tool.import";
import type {
  ApprovalRuleHours,
  KillSwitchKind,
  McpAuthStrategy,
  RegisterableMcpTransport,
  ToolClassification,
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
} from "@/data/contracts/tools";
import {
  ConnectionDetail,
  type ConnectionDetail as ConnectionDetailView,
} from "@/data/contracts/tools";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { type ConnectionScheme, CONNECTION_SCHEMES } from "./view";

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
  const ordered = <T>(record: Readonly<Record<string, T>>) =>
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

// ── Connections and tool servers (lane: connections) ────────────────────────

/** The fields the add-connection dialog collects. The secret never comes back. */
export type ConnectionDraft = {
  connectorId: string;
  displayName: string;
  scheme: ConnectionScheme;
  /** The scheme's own fields, as typed. Secret material: never logged, never returned. */
  secrets: Readonly<Record<string, string>>;
  /** Blank leaves the connector's own default in place. */
  deliveryMethod: string;
};

function refuseConnection(
  field: "connectorId" | "displayName" | "secrets",
): ActionResult<never> {
  return { ok: false, reason: "invalid", code: "invalid_input", field };
}

/**
 * Creates a data-source connection for this workspace. The handler encrypts
 * the credential before it reaches a row and asserts an org Owner or Admin, or
 * a workspace Owner, before it touches one; a refusal comes back as `denied`
 * with nothing written.
 *
 * The connection is answered `pending_setup`: creating it stores the
 * credential and nothing has yet drawn on it. The dialog says so rather than
 * reporting a live connection.
 *
 * **The credential leaves in one direction.** It is read off the form, sent to
 * the kernel and dropped: nothing here logs it, no branch puts it in a failure
 * message, and the value returned carries the connection's public id, status
 * and name only.
 */
export async function addConnection(
  org: string,
  ws: string,
  draft: ConnectionDraft,
): Promise<
  ActionResult<{
    id: string;
    status: "pending_setup";
    connectorId: string;
    displayName: string;
  }>
> {
  const connectorId = draft.connectorId.trim();
  if (connectorId === "") return refuseConnection("connectorId");
  const displayName = draft.displayName.trim();
  if (displayName === "" || displayName.length > 255) {
    return refuseConnection("displayName");
  }
  const fields = CONNECTION_SCHEMES[draft.scheme];
  const secrets: Record<string, string> = {};
  for (const field of fields) {
    const value = draft.secrets[field] ?? "";
    if (value.trim() === "") return refuseConnection("secrets");
    secrets[field] = value;
  }
  const deliveryMethod = draft.deliveryMethod.trim();

  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, connectionCreate, {
    connectorId,
    displayName,
    authCredential: { scheme: draft.scheme, type: draft.scheme, ...secrets },
    ...(deliveryMethod === "" ? {} : { deliveryMethod }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          id: result.value.publicId,
          status: result.value.status,
          connectorId: result.value.connectorId,
          displayName: result.value.displayName,
        },
      }
    : result;
}

/**
 * One connection as `get_connection` records it, for the detail drawer. The
 * drawer reads on open rather than the table reading every connection's detail
 * up front, so a workspace with many connections pays for the one opened.
 */
export async function readConnection(
  org: string,
  ws: string,
  connectionId: string,
): Promise<ActionResult<ConnectionDetailView>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: connectionGet,
    input: { connectionId: connectionId.trim() },
    page: "tools",
  });
  if (!read.ok) return readToActionResult<never>(read);
  // Mapped here rather than in `data/live/mappers`: an on-demand read belongs
  // to the action that makes it, and a feature may not import a live mapper
  // (INV-07). The record's database uuid is dropped on the way (INV-11).
  const out = read.value;
  const parsed = ConnectionDetail.safeParse({
    id: out.publicId,
    connector: out.connectorId,
    displayName: out.displayName,
    authScheme: out.authScheme,
    deliveryMethod: out.deliveryMethod,
    status: out.status,
    entityCount: out.entityCount,
    lastSyncAt: out.lastSyncAt,
    healthStatus: out.healthStatus,
    lastPollAt: out.lastPollAt,
    nextPollAt: out.nextPollAt,
    createdAt: out.createdAt,
    deliveryConfig: out.deliveryConfig,
    errorMessage: out.errorMessage,
    consecutiveFailureCount: out.consecutiveFailureCount,
    lastErrorAt: out.lastErrorAt,
    updatedAt: out.updatedAt,
  });
  if (!parsed.success) {
    return { ok: false, reason: "unavailable", code: "record_unmappable" };
  }
  return { ok: true, value: parsed.data };
}

/** The fields the register-server dialog collects. `authConfig` is secret material. */
export type McpServerDraft = {
  name: string;
  transportType: RegisterableMcpTransport;
  endpointUrl: string;
  authStrategy: McpAuthStrategy;
  /** header name to value, as typed. Never logged, never returned. */
  authConfig: Readonly<Record<string, string>>;
};

/**
 * Registers an external MCP server with this workspace. The handler health
 * checks the endpoint, envelope-encrypts the auth config and records the pins
 * it discovered; `import_tools` then pulls those pins into the registry.
 *
 * **The org role is checked here, not only in the handler.**
 * `register_mcp_server` declares org Owner or Admin and its handler asserts
 * nothing, so on a non-enterprise org `checkIAM` fast-paths the declaration to
 * an allow (#3258) and the contract's restriction holds nowhere. Refusing here
 * keeps the app from being the widest door to it. The handler is still the
 * place the assertion belongs; until it has one, this is the gate.
 */
export async function registerServer(
  org: string,
  ws: string,
  draft: McpServerDraft,
): Promise<
  ActionResult<{
    serverId: string;
    healthStatus: "healthy" | "degraded" | "unreachable";
    discoveredTools: readonly string[];
  }>
> {
  const name = draft.name.trim();
  if (name === "" || name.length > 120) {
    return {
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "name",
    };
  }
  const endpointUrl = draft.endpointUrl.trim();
  if (endpointUrl === "") {
    return {
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "endpointUrl",
    };
  }
  const authConfig: Record<string, string> = {};
  for (const [key, value] of Object.entries(draft.authConfig)) {
    const header = key.trim();
    const secret = value.trim();
    if (header === "" || secret === "") continue;
    authConfig[header] = secret;
  }
  if (draft.authStrategy !== "none" && Object.keys(authConfig).length === 0) {
    return {
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "authConfig",
    };
  }

  const ctx = await requireViewer(org, ws);
  if (ctx.orgRole !== "owner" && ctx.orgRole !== "admin") {
    return { ok: false, reason: "denied", code: "org_role_required" };
  }
  const result = await kernelWrite(ctx, agentMcpRegister, {
    name,
    transportType: draft.transportType,
    endpointUrl,
    authStrategy: draft.authStrategy,
    ...(draft.authStrategy === "none" ? {} : { authConfig }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          serverId: result.value.mcpServerId,
          healthStatus: result.value.healthStatus,
          discoveredTools: result.value.discoveredTools,
        },
      }
    : result;
}
