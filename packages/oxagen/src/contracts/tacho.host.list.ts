/** List the Tacho hosts enrolled in this workspace (fleet page, spec section 14 item 1). */
import { z } from "zod";
import { registerCapability } from "../registry";
import { hostSummarySchema, tachoHostStatusSchema } from "../tacho/schemas";

export const tachoHostList = registerCapability({
  name: "list_tacho_hosts",
  domain: "tacho",
  description:
    "List the machines enrolled as Tacho hosts in this workspace with their status, liveness, and counters.",
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
      status: tachoHostStatusSchema.optional(),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().max(256).optional(),
    })
    .strict(),
  output: z
    .object({
      hosts: z.array(hostSummarySchema).max(200),
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export type TachoHostListInput = z.output<typeof tachoHostList.input>;
export type TachoHostListOutput = z.output<typeof tachoHostList.output>;
