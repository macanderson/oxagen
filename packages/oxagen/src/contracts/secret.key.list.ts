import { z } from "zod";
import { registerCapability } from "../registry";

/** Masked key metadata — never carries a plaintext value. */
export const secretKeySummarySchema = z.object({
  id: z.string(),
  key: z.string(),
  sensitive: z.boolean(),
  memo: z.string().nullable(),
  hasDefault: z.boolean(),
  overrideEnvironmentIds: z.array(z.string()),
});

export const secretKeyList = registerCapability({
  name: "list_secret_keys",
  domain: "secret",
  description:
    "List vault secret keys for the workspace with masked metadata (which environments override each key). Never returns plaintext values.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({}),
  output: z.object({ keys: z.array(secretKeySummarySchema) }),
});

export type SecretKeyListOutput = z.output<typeof secretKeyList.output>;
