// update_runtime — rename a runtime or change whether it requires the
// contained launcher (ADR-204, #4372).
//
// A field left out keeps its current value, so a call that names neither
// changes nothing and answers the runtime as it stands. The slug does not
// follow a rename: other records and enrollments name the runtime by it.
//
// `containmentRequired` makes every agent on the runtime run only under the
// contained launcher (ADR-152). The host bundle reads it from the host's
// runtime, so each host bound to the runtime carries the change on its next
// bundle fetch. A change to it lands in the security event record with the
// value before and after.
//
// A settings write, outside the metering surface: `noBillingGate: true`.
// Roles: org Owner or Admin, checked by the handler (INV-29), the bar
// `create_runtime` sets.
import { z } from "zod";
import { registerCapability } from "../registry";
import { runtimeIdSchema, runtimeRefSchema } from "./runtime.shared";

export const runtimeUpdate = registerCapability({
  name: "update_runtime",
  domain: "runtime",
  description:
    "Rename a runtime or change whether every agent on it must run under the contained launcher. A field left out keeps its value. Hosts bound to the runtime carry the change on their next bundle fetch.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  // `app`: the Containment switch on a named runtime's page (apps/app features/runtimes).
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "identity" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      runtimeId: runtimeIdSchema,
      /** The new name. The slug stays. */
      name: z.string().trim().min(1).max(128).optional(),
      /** Whether every agent on the runtime must run under the contained launcher (ADR-152). */
      containmentRequired: z.boolean().optional(),
    })
    .strict(),
  output: z
    .object({
      runtime: runtimeRefSchema,
      containmentRequired: z.boolean(),
    })
    .strict(),
});
