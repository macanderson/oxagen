/**
 * `dismiss_finding`: close an open finding without applying its fix
 * (Mission Control spec §12.8; ADR-062). The finding keeps its evidence and
 * the decision; the job opens it again only on runs that start afterwards.
 *
 * Org Owner or Admin, checked in the handler.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { findingDecisionInputSchema, findingSchema } from "./finding.shared";

export const findingDismiss = registerCapability({
  name: "dismiss_finding",
  domain: "spend",
  description:
    "Dismiss an open finding without applying its fix (org Owner or Admin); later passes cite only runs that start after the dismissal.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  audit: { targetKind: "cost.finding", targetIdField: "findingId" },
  input: findingDecisionInputSchema,
  output: z.object({ finding: findingSchema }).strict(),
});

export type FindingDismissOutput = z.output<typeof findingDismiss.output>;
