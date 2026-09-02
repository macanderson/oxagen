import { z } from "zod";
import { registerCapability } from "../registry";

export const secretImportEnv = registerCapability({
  name: "import_env_secrets",
  domain: "secret",
  description:
    "Parse pasted .env text and (optionally) upsert keys + set values for the workspace defaults or a chosen environment. Returns a preview of new vs override rows; commit must be explicit.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "high", category: "secret" },
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    text: z.string(),
    // Omit to target the workspace default values; provide to target an environment's overrides.
    environmentId: z.string().nullable().optional(),
    // Preview-only by default; the UI/CLI confirms before committing.
    commit: z.boolean().default(false),
  }),
  output: z.object({
    rows: z.array(
      z.object({
        key: z.string(),
        isNewKey: z.boolean(),
        sensitive: z.boolean(),
        target: z.enum(["default", "override"]),
        willOverride: z.boolean(),
      }),
    ),
    committed: z.boolean(),
  }),
});

export type SecretImportEnvInput = z.output<typeof secretImportEnv.input>;
export type SecretImportEnvOutput = z.output<typeof secretImportEnv.output>;
