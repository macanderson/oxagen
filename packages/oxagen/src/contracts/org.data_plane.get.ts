import { z } from "zod";
import { registerCapability } from "../registry";
import {
  dataPlaneBindingSchema,
  dataPlaneKindSchema,
} from "./org.data_plane.shared";

/**
 * get_data_plane — read the organisation's binding for one store (ADR-042).
 *
 * The output is DELIBERATELY redacted: host + database name, mode, status, and
 * the health/rotation metadata, and nothing else. ADR-042 §4 makes this a hard
 * rule — "the raw DSN is never returned by any read capability" — because a
 * read that echoed the credential would turn every Owner/Admin token into a
 * copy of the customer's database password. An operator who needs to change the
 * credential calls set_data_plane; there is no read-back path by design.
 *
 * Organisation-level, not workspace-level: a data plane binds the whole
 * organisation (the customer's firewall is an organisation property), so
 * `scoped: false`. It still requires a real orgId — the kernel enters a tenant
 * scope whenever both ids are valid uuids.
 */
export const orgDataPlaneGet = registerCapability({
  name: "get_data_plane",
  domain: "org",
  description:
    "Read the organisation's data-plane binding for one store (postgres, neo4j, or clickhouse): shared or dedicated, its health status, endpoint host and database name, applied schema version, and the last verification/rotation timestamps. Never returns credentials or a connection string.",
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
  // Organisation-level governance: org Owner/Admin only. `workspace: {}` is
  // required by the declaration type and is deliberately EMPTY — a workspace
  // role must never reach a binding that moves the whole organisation's data.
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  // Reading where an organisation's data lives is governance, not AI usage —
  // it consumes no credits.
  noBillingGate: true,
  input: z.object({ kind: dataPlaneKindSchema }),
  output: dataPlaneBindingSchema,
});

export type OrgDataPlaneGetInput = z.output<typeof orgDataPlaneGet.input>;
export type OrgDataPlaneGetOutput = z.output<typeof orgDataPlaneGet.output>;
