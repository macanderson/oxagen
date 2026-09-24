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
  surfaces: ["api", "mcp"],
  // `app`: the Runtimes page lists these rows (apps/app features/runtimes),
  // bound in apps/app/capability-ui-map.json.
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  // `Member` was on the org map, where it is not a role: SystemOrgRole is
  // Owner | Admin | Compliance | Billing, and Member is a *workspace* role.
  // It therefore granted nothing to anybody, and a workspace member -- the
  // person who most needs to see which machines report to their workspace --
  // was denied. Moved to the map it belongs on.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
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
