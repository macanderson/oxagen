import { z } from "zod";
import { registerCapability } from "../registry";
import {
  clickhousePlaneConfigSchema,
  dataPlaneBindingSchema,
  dataPlaneKindSchema,
  dataPlaneModeSchema,
  neo4jPlaneConfigSchema,
  postgresPlaneConfigSchema,
} from "./org.data_plane.shared";

/**
 * set_data_plane — bind (or unbind) one of the organisation's stores to a
 * customer-controlled endpoint (ADR-042).
 *
 * `mode: "dedicated"` REQUIRES a `config` matching the store kind; the handler
 * envelope-encrypts it with the KMS envelope before it reaches a column, and
 * the plaintext exists only for the duration of the call. `mode: "shared"`
 * returns the organisation to the platform plane and clears the envelope.
 *
 * The per-kind config shape is validated here rather than in the handler so a
 * malformed endpoint is rejected at the surface, before any secret is written
 * — and so the MCP tool advertises the right shape to an agent. The
 * kind↔config agreement itself is a superRefine because `kind` is a sibling
 * field, not a discriminator inside `config`.
 *
 * Governed like the privileged mutation it is: org Owner/Admin only,
 * `sensitivity: "high"`, `requiresApproval: true`, and audited as a
 * `data_plane.updated` security event.
 */
/**
 * The BASE object of the input, exported separately because the registered
 * `input` is a ZodEffects (superRefine) and therefore has no `.shape`. The MCP
 * tool builds its parameter schema from this object; `invoke()` re-parses the
 * full refined contract input, so the mode↔config rules below are still
 * enforced for every surface.
 */
export const orgDataPlaneSetInputObject = z.object({
  kind: dataPlaneKindSchema,
  mode: dataPlaneModeSchema,
  config: z
    .union([
      postgresPlaneConfigSchema,
      neo4jPlaneConfigSchema,
      clickhousePlaneConfigSchema,
    ])
    .optional(),
});

const orgDataPlaneSetInput = orgDataPlaneSetInputObject.superRefine(
(value, ctx) => {
    if (value.mode === "shared") {
      if (value.config !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["config"],
          message:
            "config must be omitted when mode is 'shared' — the platform plane's connection is process env, never per-organisation state",
        });
      }
      return;
    }
    if (value.config === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config"],
        message: "config is required when mode is 'dedicated'",
      });
      return;
    }
    // The union above accepts ANY of the three shapes, so without this the
    // caller could store a Neo4j URI under kind:"clickhouse" and the store
    // client would fail at connection time with an opaque error.
    const perKind = {
      postgres: postgresPlaneConfigSchema,
      neo4j: neo4jPlaneConfigSchema,
      clickhouse: clickhousePlaneConfigSchema,
    }[value.kind];
    const parsed = perKind.safeParse(value.config);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config"],
        message: `config does not match the ${value.kind} plane shape`,
      });
    }
  },
);

export const orgDataPlaneSet = registerCapability({
  name: "set_data_plane",
  domain: "org",
  description:
    "Bind one of the organisation's stores (postgres, neo4j, or clickhouse) to a dedicated customer-controlled endpoint, or return it to the shared platform plane. The connection config is envelope-encrypted at rest and is never readable back. Returns the redacted binding.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: false,
  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "configuration",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" } },
  noBillingGate: true,
  input: orgDataPlaneSetInput,
  output: dataPlaneBindingSchema,
});

export type OrgDataPlaneSetInput = z.output<typeof orgDataPlaneSet.input>;
export type OrgDataPlaneSetOutput = z.output<typeof orgDataPlaneSet.output>;
