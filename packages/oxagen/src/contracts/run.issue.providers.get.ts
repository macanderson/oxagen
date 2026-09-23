import { z } from "zod";
import { registerCapability } from "../registry";
export const runIssueProvidersGet = registerCapability({
  name: "get_run_issue_providers",
  domain: "run",
  description:
    "Read issue provider connections and optionally list authorized Linear teams.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "app", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z
    .object({
      linearConnectionId: z.string().min(1).optional(),
      after: z.string().max(2048).optional(),
    })
    .strict(),
  output: z.object({
    github: z.object({
      connected: z.boolean(),
      connectUrl: z.string().url().nullable(),
      installUrl: z.string().url().nullable(),
      manageUrl: z.string().url().nullable(),
    }),
    linear: z.object({
      configured: z.boolean(),
      connections: z.array(
        z.object({ connectionId: z.string(), name: z.string() }),
      ),
      teams: z.array(
        z.object({ id: z.string().uuid(), name: z.string(), key: z.string() }),
      ),
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    }),
  }),
});
