import { z } from "zod";
import { registerCapability } from "../registry";

// Like secret.reveal, deliberately not exposed to the in-chat agent. Every
// export is recorded in environments.secret_access_log (Spec §7.3).
export const secretExport = registerCapability({
  name: "export_secrets",
  domain: "secret",
  description:
    "Export the resolved secret set for an environment as decrypted key/value pairs and rendered .env text. Owner/Admin only; every export is recorded in the access log.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  agent: { requiresApproval: true, riskLevel: "high", category: "secret" },
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    environmentId: z.string().nullable().optional(),
    keyIds: z.array(z.string()).nullable().optional(),
  }),
  output: z.object({
    env: z.array(z.object({ key: z.string(), value: z.string() })),
    dotenv: z.string(),
  }),
});

export type SecretExportInput = z.output<typeof secretExport.input>;
export type SecretExportOutput = z.output<typeof secretExport.output>;
