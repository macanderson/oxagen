import { z } from "zod";
import { registerCapability } from "../registry";
import { sandboxTemplateManifestSchema } from "./sandbox-template-manifest";

// Export = template row + tools + referenced key NAMES → manifest v1 JSON. No
// audit needed: a manifest carries no secret material (Spec §19.6). The manifest
// zod schema is the single source of truth, defined in sandbox-template-manifest.
export const sandboxTemplateExport = registerCapability({
  name: "export_sandbox_template",
  domain: "sandbox",
  description:
    "Export a sandbox template as a portable v1 manifest (config, tools, and required secret key NAMES — never secret values). Distribute it via the plugin/marketplace path.",
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
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ templateId: z.string().min(1) }),
  output: z.object({ manifest: sandboxTemplateManifestSchema }),
});

export type SandboxTemplateExportOutput = z.output<
  typeof sandboxTemplateExport.output
>;
