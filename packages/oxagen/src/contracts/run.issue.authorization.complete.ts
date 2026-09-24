import { z } from "zod";
import { registerCapability } from "../registry";
export const runIssueAuthorizationComplete = registerCapability({
  name: "authorize_issue_provider",
  domain: "run",
  description:
    "Complete actor-bound Linear authorization for issue follow-through.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "app", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z
    .object({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      code: z.string().min(1).max(2048),
    })
    .strict(),
  output: z.object({ connectionId: z.string().min(1) }),
});
