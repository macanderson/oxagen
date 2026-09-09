/** List Tacho sessions (parent and subagent chains) in this workspace. */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  hostEnrollmentIdSchema,
  sessionSummarySchema,
  tachoSessionOutcomeSchema,
} from "../tacho/schemas";

export const tachoSessionList = registerCapability({
  name: "list_tacho_sessions",
  domain: "tacho",
  description:
    "List Tacho sessions in this workspace, newest first, optionally filtered by host, outcome, or start time.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: {},
  },
  input: z
    .object({
      hostEnrollmentId: hostEnrollmentIdSchema.optional(),
      outcome: tachoSessionOutcomeSchema.optional(),
      /** Only sessions started at or after this instant (RFC 3339). */
      since: z.string().datetime().optional(),
      /** Include subagent chains; default lists root sessions only. */
      includeChildren: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().max(256).optional(),
    })
    .strict(),
  output: z
    .object({
      sessions: z.array(sessionSummarySchema).max(200),
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export type TachoSessionListInput = z.output<typeof tachoSessionList.input>;
export type TachoSessionListOutput = z.output<typeof tachoSessionList.output>;
