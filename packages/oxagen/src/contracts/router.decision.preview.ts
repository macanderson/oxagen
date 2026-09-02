import { z } from "zod";
import { registerCapability } from "../registry";
import {
  routingModeSchema,
  marketRouteSourceSchema,
  routingPolicySchema,
  marketCandidateSchema,
} from "./router-schema";

// `preview_routing_decision` is a DRY RUN: given a prompt (and optional
// structural signals + policy overrides), it derives the task class, reads the
// observed stats, and returns the full market decision — which model it WOULD
// pick, why, and the candidates it beat — WITHOUT running anything or changing
// state. The inspector for "what would the router do?".
export const routerDecisionPreview = registerCapability({
  name: "preview_routing_decision",
  domain: "router",
  description:
    "Dry-run the market router for a prompt: derive its task class, read observed outcomes, and return the full decision (chosen model + tier, rationale, source, and the ranked candidate audit trail) under the effective policy plus any overrides. Changes nothing.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
    },
  },
  input: z.object({
    // The prompt to route.
    prompt: z.string().min(1),
    // Optional structural signals (used only for the deterministic fallback and
    // task-class breadth bucketing).
    fileCount: z.number().int().nonnegative().optional(),
    crossPackage: z.boolean().optional(),
    // Override the derived task class (e.g. to inspect a specific class).
    taskClass: z.string().optional(),
    // Optional policy overrides layered on the effective policy for this preview.
    mode: routingModeSchema.optional(),
    successThreshold: z.number().min(0).max(1).optional(),
    minSamples: z.number().int().nonnegative().optional(),
    windowDays: z.number().int().positive().optional(),
    escalateOnRejection: z.boolean().optional(),
  }),
  output: z.object({
    tier: z.string(),
    model: z.string(),
    rationale: z.string(),
    source: marketRouteSourceSchema,
    taskClass: z.string(),
    candidates: z.array(marketCandidateSchema),
    policySnapshot: routingPolicySchema,
  }),
});

export type RouterDecisionPreviewInput = z.output<
  typeof routerDecisionPreview.input
>;
export type RouterDecisionPreviewOutput = z.output<
  typeof routerDecisionPreview.output
>;
