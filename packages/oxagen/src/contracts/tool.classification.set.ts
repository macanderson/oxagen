import { z } from "zod";
import { registerCapability } from "../registry";
import {
  toolClassificationSchema,
  toolRiskGradeSchema,
} from "./tool.classification";

export const toolClassificationSet = registerCapability({
  name: "set_tool_classification",
  domain: "tool",
  description:
    "Set a tool version's safety classification — risk grade, side-effect class, egress class, consequence tags, measures and data classes — recording who reclassified it and why. Classification describes the tool; class kill switches and approval rules decide against it.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Governance configuration, not a governed action: reclassifying spends
  // nothing and must work for an org at zero balance.
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  // The accountability chain: the version this call reclassifies, so a
  // resource-scope emergency deny naming it refuses the call (#1261).
  audit: { targetKind: "tool_version", targetIdField: "toolVersionId" },
  input: z.object({
    /** `tlv_…` */
    toolVersionId: z.string().min(1),
    riskGrade: toolRiskGradeSchema,
    classification: toolClassificationSchema,
    /** Why, recorded on the version as `classification_reason`. The security event carries the actor and the capability, not the reason. */
    reason: z.string().trim().min(1).max(500),
  }),
  output: z.object({
    toolVersionId: z.string(),
    riskGrade: toolRiskGradeSchema,
    classification: toolClassificationSchema,
    classifiedAt: z.string(),
  }),
});

export type ToolClassificationSetInput = z.output<
  typeof toolClassificationSet.input
>;
export type ToolClassificationSetOutput = z.output<
  typeof toolClassificationSet.output
>;
