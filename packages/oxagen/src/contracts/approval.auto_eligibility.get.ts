// get_auto_eligibility — what the auto-approval clause said about one approval
// request, and who resolved it (MC spec §6.9 part 2; ADR-070).
//
// The eligibility is READ, never recomputed: it is the evaluation recorded on
// the row when the call was parked, so what the page shows is what the
// decision actually was rather than what the rules would say now. A rule
// edited since is a different rule than the one that judged this call.
//
// `resolvedBy` is `policy:<rule id>` on a call no person looked at, and
// `user:<usr_…>` on one somebody answered — the receipt's Authority group
// (§6.10) and the honesty §6.9 asks for.
//
// `state` is where the request stands, read apart from who resolved it
// (#3521). A mandate revoked or expired after the call was parked sets the
// resolution to `expired` with no resolver, and a request past its expiry is
// closed whether or not the sweep has written that yet. A reader that
// inferred "still waiting" from a null `resolvedBy` offered a decision the
// handler would refuse as `approval_expired`.
import { z } from "zod";
import {
  autoEligibilitySchema,
  resolvedBySchema,
} from "../approval-rules/schemas";
import { registerCapability } from "../registry";
import { approvalIdSchema } from "./agent.approval.resolve";

/** Where an approval request stands: waiting, or the resolution it was given. */
export const approvalStateSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
]);
export type ApprovalState = z.infer<typeof approvalStateSchema>;

export const approvalAutoEligibilityGet = registerCapability({
  name: "get_auto_eligibility",
  domain: "approval_rule",
  description:
    "The auto-approval evaluation recorded for one approval request, where the request stands, and who resolved it",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "approval" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: {},
  },
  input: z.object({ approvalId: approvalIdSchema }).strict(),
  output: z
    .object({
      /** Echoes the id in the form the caller sent. */
      approvalId: z.string(),
      /**
       * Where the request stands. `pending` only while it has no resolution
       * and its expiry has not passed; `expired` also covers a request whose
       * expiry passed before anything wrote the resolution.
       */
      state: approvalStateSchema,
      /** Null while the request is still waiting, and on one that expired. */
      resolvedBy: resolvedBySchema.nullable(),
      /**
       * The display name of the person `resolvedBy` names, so a reader can
       * say who answered rather than print a public id. Null when a rule or
       * nobody resolved the request, or the account has no display name.
       */
      resolvedByName: z.string().min(1).max(256).nullable(),
      /** Null when no rule covered the call when it was parked. */
      eligibility: autoEligibilitySchema.nullable(),
    })
    .strict(),
});

export type ApprovalAutoEligibilityGetInput = z.output<
  typeof approvalAutoEligibilityGet.input
>;
export type ApprovalAutoEligibilityGetOutput = z.output<
  typeof approvalAutoEligibilityGet.output
>;
