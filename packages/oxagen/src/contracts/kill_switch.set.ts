import { z } from "zod";
import { registerCapability } from "../registry";
import { consequenceTagSchema } from "./tool.classification";

/**
 * What a kill switch stops (MC spec §6.11). Every level is a deny that takes
 * effect at the next call boundary through the deny generation.
 *
 * The `id` is the public id of the target — `tlv_…`, `mcs_…`, `mcrd_…`,
 * `agt_…`, a user id, a workspace id, the organisation id — or, for a class,
 * the consequence tag every tool carrying it is stopped by.
 */
export const killSwitchTargetKindSchema = z.enum([
  "tool_version",
  "tool_server",
  "connection",
  "agent",
  "operator",
  "workspace",
  "org",
  "class",
]);

export const killSwitchTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool_version"), id: z.string().min(1) }),
  z.object({ kind: z.literal("tool_server"), id: z.string().min(1) }),
  z.object({ kind: z.literal("connection"), id: z.string().min(1) }),
  z.object({ kind: z.literal("agent"), id: z.string().min(1) }),
  z.object({ kind: z.literal("operator"), id: z.string().uuid() }),
  z.object({ kind: z.literal("workspace"), id: z.string().uuid() }),
  z.object({ kind: z.literal("org"), id: z.string().uuid() }),
  z.object({ kind: z.literal("class"), id: consequenceTagSchema }),
]);

/** The org-wide and workspace generations after the flip (the one invalidation counter). */
export const denyGenerationSchema = z.object({
  org: z.number().int().nonnegative(),
  workspace: z.number().int().nonnegative(),
});

export const killSwitchSet = registerCapability({
  name: "set_kill_switch",
  domain: "kill_switch",
  description:
    "Flip a kill switch on or off: an emergency deny against a tool version, a tool server, a connection, an agent, an operator, a workspace, the organisation or a consequence class. Takes effect at the next call boundary by bumping the deny generation in the same transaction; a connection switch revokes its live credential grants; every flip that changes a switch is a security event.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Emergency governance is never refused for lack of GAUs.
  noBillingGate: true,
  // On the agent surface a flip pauses for a human (ARCHITECTURE.md §3.2:
  // `pending_approval`, rendered as waiting).
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    target: killSwitchTargetSchema,
    on: z.boolean(),
    /**
     * Why. Recorded on the deny row: as `reason` when flipping on, as
     * `cleared_reason` when flipping off. Not recorded when the switch is
     * already on and nothing changes. The security event carries the actor
     * and the capability, not the reason.
     */
    reason: z.string().trim().min(1).max(500),
  }),
  output: z.object({
    /** `emd_…` of the deny row this flip wrote or cleared. */
    switchId: z.string(),
    on: z.boolean(),
    /** False when the switch was already in the requested state and nothing changed. */
    changed: z.boolean(),
    denyGeneration: denyGenerationSchema,
    /** Credential grants a connection switch revoked; 0 for every other kind. */
    grantsRevoked: z.number().int().nonnegative(),
  }),
});

export type KillSwitchSetInput = z.output<typeof killSwitchSet.input>;
export type KillSwitchSetOutput = z.output<typeof killSwitchSet.output>;
export type KillSwitchTarget = z.output<typeof killSwitchTargetSchema>;
export type KillSwitchTargetKind = z.output<typeof killSwitchTargetKindSchema>;
export type DenyGeneration = z.output<typeof denyGenerationSchema>;
