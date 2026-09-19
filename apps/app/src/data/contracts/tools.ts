// The Tools page's view models (ARCHITECTURE.md §3.3, §3.4; #2958): the
// workspace registry's tool versions with the classification and the kill
// switch that stops each one today (`list_tool_versions`), the credential
// broker's grants (`list_credential_grants`), and the kill switches reaching
// this workspace with the deny generation they bump (`list_kill_switches`),
// and the workspace's auto-approval rules with what each did over the last 30
// days (`list_approval_rules`, MC spec §6.9 part 2, ADR-070).
//
// Every id a view carries is a prefixed public id (INV-11). The three target
// kinds whose id is a database uuid — operator, workspace, org — and the user
// id a flip records are therefore carried as `…Ref`, not as an id field, and
// the page prints the kind rather than the uuid (CLAUDE.md, citing nodes).
import { z } from "zod";
import { PublicId } from "./common";

const Instant = z.iso.datetime();
const Count = z.number().int().nonnegative();

/** `tools.tool_versions.classification` (spec §6.9 part 1), as the contract spells it. */
export const ToolRiskGrade = z.enum(["low", "medium", "high", "critical"]);
export type ToolRiskGrade = z.infer<typeof ToolRiskGrade>;

export const ToolSideEffect = z.enum(["read", "write", "irreversible"]);
export type ToolSideEffect = z.infer<typeof ToolSideEffect>;

export const ToolEgress = z.enum(["local", "org_tenant", "third_party"]);
export type ToolEgress = z.infer<typeof ToolEgress>;

/** snake_case, the starter set and every customer tag; the registry's "category". */
const ConsequenceTag = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

/** The tag that makes a tool version financial (spec §6.9; the mockup's `moves_funds`). */
export const MONEY_TAG = "moves_money";

/** Which active switch stops a version today, in the recorded decision order (INV-10). */
const ToolGate = z.object({
  kind: z.enum(["open", "killed_version", "killed_server", "killed_class"]),
  /** The `emd_…` of the switch that stops it; null when the gate is open. */
  switchId: PublicId.nullable(),
});

/**
 * A path into the call's input the mandate gate measures. Authored where the
 * tool is declared or imported, never on this page: reclassifying carries the
 * version's measures through unchanged.
 */
const ToolMeasure = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  type: z.enum([
    "money",
    "count",
    "identifier",
    "environment",
    "table",
    "text",
  ]),
  /** For `money`: where the call carries the currency. */
  currencyPath: z.string().min(1).nullable(),
  /** For `count`: what is counted. */
  unit: z.string().min(1).nullable(),
});

export const ToolClassification = z.object({
  sideEffect: ToolSideEffect,
  egress: ToolEgress,
  consequenceTags: z.array(ConsequenceTag),
  dataClasses: z.array(z.string().min(1)),
  measures: z.array(ToolMeasure),
});
export type ToolClassification = z.infer<typeof ToolClassification>;

export const ToolVersion = z.object({
  id: PublicId,
  toolId: PublicId,
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  version: z.number().int().positive(),
  source: z.enum(["builtin", "custom", "mcp", "foundry"]),
  /** The server an imported tool came from; null for a declared tool. */
  serverId: PublicId.nullable(),
  /** `mcp.<server>.<tool>` for an imported tool: the capability a call is governed under. */
  capability: z.string().min(1),
  readOnly: z.boolean(),
  riskGrade: ToolRiskGrade,
  /** Null until an admin classifies the version. */
  classification: ToolClassification.nullable(),
  classifiedAt: Instant.nullable(),
  schemaOrigin: z.enum(["declared", "imported"]),
  /** SHA-256 hex over the canonical manifest. */
  schemaDigest: z.string().min(1),
  enabled: z.boolean(),
  gate: ToolGate,
  /** Calls in the last 30 days; null when ClickHouse did not answer. */
  calls30d: Count.nullable(),
  updatedAt: Instant,
});
export type ToolVersion = z.infer<typeof ToolVersion>;

export const ToolVersionPage = z.object({
  items: z.array(ToolVersion),
  nextCursor: z.string().min(1).nullable(),
});
export type ToolVersionPage = z.infer<typeof ToolVersionPage>;

/** How far the broker narrowed the credential for one use (spec §6.8). */
const GrantDownscope = z.enum([
  "token_exchange",
  "session_policy",
  "restricted_key",
  "none",
]);

export const CredentialGrant = z.object({
  id: PublicId,
  /** The stored credential the grant drew on. */
  connectionId: PublicId,
  serverId: PublicId,
  serverName: z.string().min(1),
  /** The governed run it served; null for a turn outside a run. */
  runId: PublicId.nullable(),
  scope: z.object({
    endpointUrl: z.string().min(1),
    authKind: z.enum(["oauth", "secret"]),
    downscope: GrantDownscope,
  }),
  issuedAt: Instant,
  expiresAt: Instant,
  revokedAt: Instant.nullable(),
  status: z.enum(["active", "expired", "revoked"]),
});
export type CredentialGrant = z.infer<typeof CredentialGrant>;

export const CredentialGrantPage = z.object({
  items: z.array(CredentialGrant),
  nextCursor: z.string().min(1).nullable(),
});
export type CredentialGrantPage = z.infer<typeof CredentialGrantPage>;

/**
 * How many switches the board asks for: the ceiling `list_kill_switches`
 * offers. The contract has no cursor, so this is the whole read — asking for
 * its maximum is the most board the page can show, and `truncated` says when
 * even that was not all of it.
 */
export const KILL_SWITCH_BOARD_LIMIT = 200;

/** Every level a deny is available at (spec §6.11), in the order the page draws them. */
export const KILL_SWITCH_KINDS = [
  "class",
  "org",
  "workspace",
  "tool_server",
  "tool_version",
  "connection",
  "agent",
  "operator",
] as const;
export const KillSwitchKind = z.enum(KILL_SWITCH_KINDS);
export type KillSwitchKind = z.infer<typeof KillSwitchKind>;

/**
 * What a switch names. `ref` is the target's public id, or the consequence tag
 * for a class switch — and, for the operator, workspace and org kinds, the
 * database uuid the contract carries, which the page never prints as a label.
 */
const KillSwitchTarget = z.object({
  kind: KillSwitchKind,
  ref: z.string().min(1),
});

export const KillSwitch = z.object({
  id: PublicId,
  target: KillSwitchTarget,
  /** `org` for an org-wide switch (org, class), `workspace` otherwise. */
  scope: z.enum(["org", "workspace"]),
  on: z.boolean(),
  reason: z.string(),
  /** The user id of whoever flipped it on; the record carries no display name. */
  flippedByRef: z.string().min(1).nullable(),
  flippedAt: Instant,
  clearedAt: Instant.nullable(),
  clearedByRef: z.string().min(1).nullable(),
});
export type KillSwitch = z.infer<typeof KillSwitch>;

/** The one invalidation counter a flip bumps, org-wide and for this workspace. */
const DenyGeneration = z.object({ org: Count, workspace: Count });

export const KillSwitchBoard = z.object({
  denyGeneration: DenyGeneration,
  switches: z.array(KillSwitch),
  /**
   * True when the read came back at the ceiling it asked for.
   *
   * `list_kill_switches` carries no cursor, so there is no later page to
   * fetch: a full answer is the newest N switches and not the board. The page
   * says so where the board is drawn and marks the tab's count as a floor,
   * because a board that silently drops an older switch that is still denying
   * is a board nobody can clear it from.
   */
  truncated: z.boolean(),
});
export type KillSwitchBoard = z.infer<typeof KillSwitchBoard>;

/** A rule id: the lowercase slug a receipt cites as `policy:<id>`. */
const ApprovalRuleId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

/** The hours a rule admits, local to its own zone; days are ISO weekdays. */
const ApprovalRuleHours = z.object({
  timezone: z.string().min(1),
  days: z.array(z.number().int().min(1).max(7)).min(1),
  /** `HH:MM`, 24-hour; the window is `[start, end)`. */
  start: z.string().min(1),
  end: z.string().min(1),
});
export type ApprovalRuleHours = z.infer<typeof ApprovalRuleHours>;

/**
 * One auto-approval rule (MC spec §6.9 part 2): the conditions under which a
 * call the policy sent to a person may skip them, and what it did in the
 * window. Every field the contract stores is carried, because the edit dialog
 * shows the rule as it is written, not a summary of it.
 */
export const ApprovalRule = z.object({
  id: ApprovalRuleId,
  name: z.string().min(1),
  /** Globs over a declared tool's `slug@version` or its bare slug. */
  tools: z.array(z.string().min(1)).min(1),
  enabled: z.boolean(),
  /** measure → the inclusive ceiling, an integer string (INV-09). */
  maxMeasures: z.record(z.string(), z.string()),
  /** measure → the globs its target must match. */
  allowTargets: z.record(z.string(), z.array(z.string().min(1))),
  /** The window a person's approval of the same call re-applies in; null asks for none. */
  standingWindowMs: z.number().int().positive().nullable(),
  businessHours: ApprovalRuleHours.nullable(),
  /** The `usr_…` of whoever last wrote the rule; null when no person did. */
  lastWrittenBy: PublicId.nullable(),
  /** The contract admits an offset here, so the view does too. */
  lastWrittenAt: z.iso.datetime({ offset: true }),
  /**
   * The consequence tags the rule's tools carried when it was last written.
   * Null when the record carries no stamp, which the evaluator reads as "does
   * not qualify" until the rule is saved again.
   */
  authoredConsequences: z.array(ConsequenceTag).nullable(),
  /** Calls this rule released with no person in the window. */
  released: Count,
  /** Calls in the window that reached a person with this rule read beside them. */
  held: Count,
});
export type ApprovalRule = z.infer<typeof ApprovalRule>;

export const ApprovalRuleSet = z.object({
  rules: z.array(ApprovalRule),
  /** The window the two counters are measured over, in days. */
  windowDays: z.number().int().positive(),
});
export type ApprovalRuleSet = z.infer<typeof ApprovalRuleSet>;
