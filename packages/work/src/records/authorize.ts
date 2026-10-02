// authorize.ts: who may take each Phase 1 action on a work item.
//
// A work item grants no authority. Every action is checked on the server
// against the actor's roles in the item's own org and workspace, whatever the
// interface shows. The roles below are the shape assertOrgRole
// (packages/iam/src/org-role.ts) takes, so a handler passes them unchanged.
//
// Each action names the permission bundle from the role editor's catalogue it
// belongs to (packages/oxagen/src/iam/permission-catalog.ts): reading takes
// run.read, approving a brief and accepting work take work.approve, and every
// other action takes work.control (oxagen-roadmap mockups/pages/work-item.md,
// Permissions, which proposed run.approve and run.control). The Work actions
// have bundles of their own because a bundle reads as held only when every
// capability in it is allowed: adding them to run.control would have taken
// run.control away from every role that held it (ADR-251).
//
// Separation of duties: in a workspace whose governance mode is regulated, the
// person who approved a brief cannot send it (tasks-spec.md §8.4). Anyone who
// sends must operate the target agent (tasks-spec.md §12).
import { WorkRecordError } from "./errors";

/** The Phase 1 actions on a work item. */
export const WORK_ITEM_ACTIONS = [
  "read",
  "enter",
  "correct_triage",
  "save_brief",
  "approve_brief",
  "send",
  "withdraw",
  "stop",
  "return",
  "accept",
  "close",
  "reopen",
] as const;
export type WorkItemAction = (typeof WORK_ITEM_ACTIONS)[number];

/** The role editor's permission bundles the Work actions belong to. */
export const WORK_PERMISSIONS = ["run.read", "work.approve", "work.control"] as const;
export type WorkPermission = (typeof WORK_PERMISSIONS)[number];

/** The permission each action takes. */
export const WORK_ACTION_PERMISSION: Readonly<Record<WorkItemAction, WorkPermission>> = {
  read: "run.read",
  enter: "work.control",
  correct_triage: "work.control",
  save_brief: "work.control",
  approve_brief: "work.approve",
  send: "work.control",
  withdraw: "work.control",
  stop: "work.control",
  return: "work.control",
  accept: "work.approve",
  close: "work.control",
  reopen: "work.control",
};

/** The roles assertOrgRole checks: an org role, or a workspace role on the item's workspace. */
export interface WorkRoleRequirement {
  org: readonly string[];
  workspace: readonly string[];
}

const ORG_ADMINS = ["Owner", "Admin"] as const;

/** The roles each permission admits by default. A workspace Viewer reads and does nothing else. */
export const WORK_PERMISSION_ROLES: Readonly<Record<WorkPermission, WorkRoleRequirement>> = {
  "run.read": { org: ORG_ADMINS, workspace: ["Owner", "Member", "Viewer"] },
  "work.approve": { org: ORG_ADMINS, workspace: ["Owner", "Member"] },
  "work.control": { org: ORG_ADMINS, workspace: ["Owner", "Member"] },
};

/** The roles that may take an action. Pure. */
export function workActionRoles(action: WorkItemAction): WorkRoleRequirement {
  return WORK_PERMISSION_ROLES[WORK_ACTION_PERMISSION[action]];
}

/** A workspace's governance mode, from its steering governance.toml. Null when it has none. */
export type GovernanceMode = "solo" | "team" | "regulated" | null;

/** What the duty check needs to know about a send. */
export interface SendDutyInput {
  /** The person sending. */
  actorId: string;
  governanceMode: GovernanceMode;
  /** The person who approved the brief being sent. */
  approverId: string;
  /** Whether the actor operates the target agent. */
  operatesAgent: boolean;
}

/**
 * Refuse a send that breaks a duty rule: the sender must operate the target
 * agent, and in a regulated workspace the approver cannot be the sender.
 * Throws forbidden. Pure.
 */
export function checkSendDuties(input: SendDutyInput): void {
  if (!input.operatesAgent) {
    throw new WorkRecordError("forbidden", "You do not operate this agent. Send work only to an agent you operate.");
  }
  if (input.governanceMode === "regulated" && input.actorId === input.approverId) {
    throw new WorkRecordError(
      "forbidden",
      "This workspace is regulated, and you approved this brief. Another person must send it.",
    );
  }
}
