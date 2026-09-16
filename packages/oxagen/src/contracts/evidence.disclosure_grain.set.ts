/**
 * `set_disclosure_grain`: how much a worker is told when a witness it cannot
 * see fails (Mission Control spec §8.5 invariant 3; ADR-064). `L0` is pass or
 * fail and nothing else; `L1` names the criterion, `L2` describes a symptom,
 * `L3` hands over a regenerated reproduction.
 *
 * A person decides it: the handler accepts an org Owner or Admin in a
 * signed-in session, refuses every API-key caller, and records the change as
 * `evidence.disclosure_grain_changed`. No MCP surface, for the same reason.
 * Changing a setting is never a governed action (ADR-052 exclusion 2).
 */
import { z } from "zod";
import { DISCLOSURE_GRAINS } from "@oxagen/run-evidence";
import { registerCapability } from "../registry";

const grainSchema = z.enum(DISCLOSURE_GRAINS);

export const evidenceDisclosureGrainSet = registerCapability({
  name: "set_disclosure_grain",
  domain: "evidence",
  description:
    "Set the workspace's witness disclosure grain, from L0 (the worker hears only pass or fail) to L3, recorded as a security event.",
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
    workspace: {},
  },
  input: z.object({ grain: grainSchema }).strict(),
  output: z
    .object({
      grain: grainSchema,
      /** The grain in force before this write; `L0` when none was set. */
      previousGrain: grainSchema,
      /**
       * RFC 3339: when the stored grain last changed; null when nobody ever
       * set one and `L0` was asked for, so nothing was written.
       */
      changedAt: z.string().datetime().nullable(),
    })
    .strict(),
});
