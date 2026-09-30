/**
 * `set_operator_pseudonyms`: turn the workspace's operator pseudonyms on or
 * off (spend spec, Operator ranking). With them on, the operator ranking
 * shows a stable pseudonym in place of each name, for a workspace where a
 * works council or local law requires it. The ranks, the unproductive spend
 * and the share of the total stay. Each operator's unproductive share, run
 * count and runs are withheld, since each could match a pseudonym to a name
 * on the operator rollup. An org Owner or Admin sets it, and each change
 * writes a security event.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const spendOperatorPseudonymsSet = registerCapability({
  name: "set_operator_pseudonyms",
  domain: "spend",
  description:
    "Turn the workspace's operator pseudonyms on or off. With them on, the operator ranking shows a stable pseudonym in place of each name, keeps the ranks and the unproductive spend, and withholds each operator's unproductive share, run count, and runs. Org Owner or Admin only.",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "app", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  agent: { requiresApproval: true, riskLevel: "high", category: "privacy" },
  input: z.object({ enabled: z.boolean() }).strict(),
  output: z.object({ pseudonyms: z.boolean() }).strict(),
});

export type SpendOperatorPseudonymsSetInput = z.output<
  typeof spendOperatorPseudonymsSet.input
>;
export type SpendOperatorPseudonymsSetOutput = z.output<
  typeof spendOperatorPseudonymsSet.output
>;
