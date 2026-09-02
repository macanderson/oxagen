import { z } from "zod";
import { registerCapability } from "../registry";

export const secretKeyUpsert = registerCapability({
  name: "upsert_secret_key",
  domain: "secret",
  description:
    "Create or update a vault secret key (workspace root). Sensitive keys (default) are envelope-encrypted; an optional default value applies when an environment has no override.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "high", category: "secret" },
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    key: z.string().min(1),
    sensitive: z.boolean().default(true),
    memo: z.string().nullable().optional(),
    // undefined leaves the default unchanged; null clears it; string sets it.
    defaultValue: z.string().nullable().optional(),
  }),
  output: z.object({ id: z.string() }),
});

export type SecretKeyUpsertInput = z.output<typeof secretKeyUpsert.input>;
export type SecretKeyUpsertOutput = z.output<typeof secretKeyUpsert.output>;
