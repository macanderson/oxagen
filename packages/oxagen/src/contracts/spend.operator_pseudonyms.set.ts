/**
 * `set_operator_pseudonyms`: turn the workspace's operator pseudonyms on or
 * off (spend spec, Operator ranking). With them on, the operator ranking
 * shows a stable pseudonym in place of each name, for a workspace where a
 * works council or local law requires it. The figures stay. An org Owner or
 * Admin sets it, and each change writes a security event.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const spendOperatorPseudonymsSet = registerCapability({
  name: "set_operator_pseudonyms",
  domain: "spend",
  description:
    "Turn the workspace's operator pseudonyms on or off. With them on, the operator ranking shows a stable pseudonym in place of each name and the figures stay. Org Owner or Admin only.",
  mode: "sync",
  surfaces: ["api"],
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
  input: z.object({ enabled: z.boolean() }).strict(),
  output: z.object({ pseudonyms: z.boolean() }).strict(),
});

export type SpendOperatorPseudonymsSetInput = z.output<
  typeof spendOperatorPseudonymsSet.input
>;
export type SpendOperatorPseudonymsSetOutput = z.output<
  typeof spendOperatorPseudonymsSet.output
>;
