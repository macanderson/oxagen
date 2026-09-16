import { z } from "zod";
import { registerCapability } from "../registry";
import {
  denyGenerationSchema,
  killSwitchTargetSchema,
} from "./kill_switch.set";

export const killSwitchItemSchema = z.object({
  /** `emd_…` */
  id: z.string(),
  target: killSwitchTargetSchema,
  /** `org` for an org-wide switch (org, class), `workspace` otherwise. */
  scope: z.enum(["org", "workspace"]),
  on: z.boolean(),
  reason: z.string(),
  /** User id of who flipped it on; null when written by another path. */
  flippedBy: z.string().nullable(),
  flippedAt: z.string(),
  /** When it was flipped off; null while on. */
  clearedAt: z.string().nullable(),
  /** User id of who flipped it off; null while on. */
  clearedBy: z.string().nullable(),
});

export const killSwitchList = registerCapability({
  name: "list_kill_switches",
  domain: "kill_switch",
  description:
    "List the kill switches reaching this workspace — org-wide class and organisation switches and the workspace's own — newest first, with the current deny generation.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** Only switches currently on. */
    onlyOn: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  output: z.object({
    denyGeneration: denyGenerationSchema,
    switches: z.array(killSwitchItemSchema),
  }),
});

export type KillSwitchListInput = z.output<typeof killSwitchList.input>;
export type KillSwitchListOutput = z.output<typeof killSwitchList.output>;
export type KillSwitchItem = z.output<typeof killSwitchItemSchema>;
