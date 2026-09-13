// Spec-vocabulary enums the primitives need that src/data/contracts does not
// carry yet. Each follows the spec (§3, §6, App. A), never the mockup's strings,
// and is written as a zod enum so promoting it into src/data/contracts is a move.
// PROMOTE: RunStatus → contracts/runs.ts (plan §4.5), AgentStatus and
// PrincipalKind → contracts/agents.ts, GateDecision and ToolCategory →
// contracts/tools.ts.
import { z } from "zod";

/** Run lifecycle (plan §4.5 `RunStatus`). */
export const RunStatus = z.enum([
  "live",
  "parked",
  "pausing",
  "paused",
  "resuming",
  "sealed",
  "halted",
  "compacted",
]);
export type RunStatus = z.infer<typeof RunStatus>;

/** Agent enrollment status (plan W3: `unenrolled/active/suspended/retired`). */
export const AgentStatus = z.enum([
  "unenrolled",
  "active",
  "suspended",
  "retired",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

/** The three principal kinds IAM decides about (spec §3). */
export const PrincipalKind = z.enum(["human", "agent", "service"]);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

/**
 * What stands between a toolbelt and dispatch for one tool version: the policy
 * effect (`allow`, `require_approval`, `deny`, spec §6.3), plus the two states
 * that outrank it on the Tools page, a mandate (§6.9) and a kill switch (§6.11).
 */
export const GateDecision = z.enum([
  "allow",
  "require_approval",
  "mandate",
  "deny",
  "killed",
]);
export type GateDecision = z.infer<typeof GateDecision>;

/** What a tool acts on, least to most consequential (Tools › taxonomy). */
export const ToolCategory = z.enum([
  "read",
  "query",
  "record",
  "message",
  "file",
  "exec",
  "vcs",
  "infra",
  "access",
  "finance",
]);
export type ToolCategory = z.infer<typeof ToolCategory>;
