// list_runtimes — the runtimes named in this workspace and the agents on each
// (ADR-198, #4369).
//
// The register form reads this to keep a runtime and harness pair from being
// registered twice: each runtime lists its live agents with their harness, so
// the form disables a runtime that already runs the chosen harness, and a
// harness the chosen runtime already runs, and says which agent holds it.
// A retired agent frees its pair and is not listed.
//
// A console read is outside the metering surface (ADR-052 exclusion 2,
// INV-28): `noBillingGate: true`, `mutates: false`.
import { z } from "zod";
import { registerCapability } from "../registry";
import { agentHarnessSchema } from "./agent.list";
import { runtimeRefSchema } from "./runtime.shared";

const instant = z.string().datetime({ offset: true });

export const runtimeListItem = runtimeRefSchema
  .extend({
    createdAt: instant,
    /** The live agents on this runtime, one per harness (ADR-198). */
    agents: z
      .array(
        z
          .object({
            /** `agt_…`. */
            id: z.string().regex(/^agt_[0-9a-z]+$/),
            name: z.string().min(1),
            slug: z.string().min(1),
            harness: agentHarnessSchema,
          })
          .strict(),
      )
      .max(16),
    /** Host enrollments bound to this runtime that are not revoked. */
    liveHosts: z.number().int().nonnegative(),
    /** The newest `last_seen_at` among its hosts; null when none has reported. */
    lastSeenAt: instant.nullable(),
  })
  .strict();
export type RuntimeListItem = z.output<typeof runtimeListItem>;

export const runtimeList = registerCapability({
  name: "list_runtimes",
  domain: "runtime",
  description:
    "List the runtimes named in this workspace, each with the live agents on it and their harness, the live host enrollments bound to it, and when a host last reported.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  // `app`: the Runtimes page and the register form's runtime picker.
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}).strict(),
  output: z
    .object({
      items: z.array(runtimeListItem).max(500),
    })
    .strict(),
});
