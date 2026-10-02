// get_steering_pr — one proposal's steering PR: the state machine, its checks,
// what merge will do and, once merged, the promotion event (ADR-061; MC spec
// §10.3). The read the steering PR panel polls while checks run.
//
// It answers open_steering_pr's view and two more fields (#4518, ADR-267):
// the managed-block findings the latest check run stored, which the panel
// draws Restore block from, and the approvals recorded in Oxagen at the
// checked head. Both come from Postgres, so the page's poll reads no host.
import { z } from "zod";
import { registerCapability } from "../registry";
import { checkFindingSchema } from "./context.steering.shared";
import { steeringPrSchema } from "./steering.pr.open";

/** open_steering_pr's view, the latest run's findings, and the approvals given in Oxagen. */
export const steeringPrReadSchema = steeringPrSchema
  .extend({
    /**
     * What the latest check run found on the head beyond the six outcomes:
     * each drifted managed block. Empty before a run finishes and on a
     * repository that keeps the legacy layout.
     */
    findings: z.array(checkFindingSchema),
    /**
     * How many people approved the checked head in Oxagen
     * (approve_steering_pr). A review on the host is not counted here. The
     * merge counts both.
     */
    approvals: z.number().int().nonnegative(),
  })
  .strict();
export type SteeringPrRead = z.infer<typeof steeringPrReadSchema>;

export const steeringPrGet = registerCapability({
  name: "get_steering_pr",
  domain: "context",
  description:
    "Get a proposal's steering PR: state, branch, checks with their outcomes, the managed blocks the latest check run found drifted, the approvals given in Oxagen at the checked head, what merge will do, and the promotion event once merged",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      proposalId: z.string().regex(/^prp_[0-9A-Za-z]+$/),
    })
    .strict(),
  output: steeringPrReadSchema,
});

export type SteeringPrGetInput = z.output<typeof steeringPrGet.input>;
export type SteeringPrGetOutput = z.output<typeof steeringPrGet.output>;
