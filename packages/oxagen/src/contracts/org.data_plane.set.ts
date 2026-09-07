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
 * The BASE object of the input, exported separately because the registered
 * `input` is a ZodEffects (superRefine) and therefore has no `.shape`. The MCP
 * tool builds its parameter schema from this object; `invoke()` re-parses the
 * full refined contract input, so the mode↔config rules below still apply on
 * every surface.
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

/**
 * Two cross-field rules the object alone cannot express:
 *
 *  1. `dedicated` requires a config, `shared` forbids one. The platform plane's
 *     connection is process env, never per-organisation state, so accepting a
 *     config alongside `shared` would silently store a secret nothing reads.
 *  2. The config must match the DECLARED kind. The union above accepts any of
 *     the three shapes, so without this a caller could store a Neo4j URI under
 *     `kind: "clickhouse"` and the failure would surface much later as an
 *     opaque connection error against a live customer endpoint.
 */
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
    const perKind = {
      postgres: postgresPlaneConfigSchema,
      neo4j: neo4jPlaneConfigSchema,
      clickhouse: clickhousePlaneConfigSchema,
    }[value.kind];
    if (!perKind.safeParse(value.config).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config"],
        message: `config does not match the ${value.kind} plane shape`,
      });
    }
  },
);

/**
 * set_data_plane — bind (or unbind) one of the organisation's stores to a
 * customer-controlled endpoint (ADR-042).
 *
 * `mode: "dedicated"` carries the plaintext connection config; the handler
 * envelope-encrypts it with the KMS envelope before it reaches a column, and
 * the plaintext exists only for the duration of the call. `mode: "shared"`
 * returns the organisation to the platform plane and clears the envelope.
 *
 * Organisation-level, not workspace-level: the customer's firewall is an
 * organisation property (ADR-042 alternatives), so `scoped: false`.
 *
 * Governed like the privileged mutation it is — org Owner/Admin only,
 * `sensitivity: "high"`, `requiresApproval: true` — and audited as a
 * `data_plane.updated` security event. The output is the same REDACTED binding
 * `get_data_plane` returns: setting a plane never echoes the credential back.
 */
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
  // Changing where an organisation's data lives is governance, not AI usage —
  // it consumes no credits.
  noBillingGate: true,
  input: orgDataPlaneSetInput,
  output: dataPlaneBindingSchema,
});

export type OrgDataPlaneSetInput = z.output<typeof orgDataPlaneSet.input>;
export type OrgDataPlaneSetOutput = z.output<typeof orgDataPlaneSet.output>;
