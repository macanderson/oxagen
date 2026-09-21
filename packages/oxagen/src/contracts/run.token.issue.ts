import { z } from "zod";
import { registerCapability } from "../registry";

export const runTokenIssue = registerCapability({
  name: "create_run_token",
  domain: "run",
  description:
    "Issue a fifteen-minute evidence credential for one existing run attempt.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      runId: z.string().regex(/^arun_[a-zA-Z0-9]+$/),
      attemptId: z.string().regex(/^arat_[a-zA-Z0-9]+$/),
    })
    .strict(),
  output: z
    .object({ token: z.string(), expiresAt: z.string().datetime() })
    .strict(),
});
