import { z } from "zod";
import { registerCapability } from "../registry";
export const runIssueAuthorizationBegin = registerCapability({
  name: "start_issue_authorization",
  domain: "run",
  description: "Start Linear authorization for issue follow-through.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "app", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ provider: z.literal("linear") }).strict(),
  output: z.object({ authorizeUrl: z.string().url() }),
});
