/**
 * `get_finding_evidence`: the runs, calls and prices one finding cites
 * (Mission Control spec §12.8; ADR-062). The evidence is the arithmetic the
 * findings job wrote with the finding: what the cited calls cost, what the
 * counterfactual would have cost, and the runs with the largest saving.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  findingDecisionInputSchema,
  findingEvidenceSchema,
  findingSchema,
} from "./finding.shared";

export const findingEvidenceGet = registerCapability({
  name: "get_finding_evidence",
  domain: "spend",
  description:
    "Get the evidence behind one finding: the calls it cites and how many the counterfactual covers, the tokens and money they cost against the counterfactual, and the cited runs with the largest saving.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: findingDecisionInputSchema,
  output: z
    .object({ finding: findingSchema, evidence: findingEvidenceSchema })
    .strict(),
});

export type FindingEvidenceGetOutput = z.output<
  typeof findingEvidenceGet.output
>;
