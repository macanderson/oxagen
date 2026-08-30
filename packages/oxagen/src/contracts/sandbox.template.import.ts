import { z } from "zod";
import { registerCapability } from "../registry";
import { sandboxTemplateManifestSchema } from "./sandbox-template-manifest";
import { sandboxTemplateSummarySchema } from "./sandbox.template.create";

// Import = zod-validate manifest → create template (non-default unless
// setAsDefault) under a caller-chosen environment + tools rows + secret-key
// upserts (NAMES only, no values). Slug collision rejects with a clear error
// unless the caller passes a `slug` override. Unknown tool refs not installed in
// the workspace do NOT fail — they surface in warnings[] (Spec §3).
export const sandboxTemplateImport = registerCapability({
  name: "import_sandbox_template",
  domain: "sandbox",
  description:
    "Import a portable sandbox-template manifest into an environment. Creates the template (non-default unless setAsDefault), its tools, and upserts missing secret keys (no values). Returns warnings for uninstalled tool refs and slug collisions.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "configuration",
  },
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    environmentId: z.string().min(1),
    manifest: sandboxTemplateManifestSchema,
    // Overrides the manifest slug (use to resolve a collision).
    slug: z.string().min(1).optional(),
    setAsDefault: z.boolean().optional(),
  }),
  output: z.object({
    template: sandboxTemplateSummarySchema,
    warnings: z.array(z.string()),
  }),
});

export type SandboxTemplateImportInput = z.output<
  typeof sandboxTemplateImport.input
>;
export type SandboxTemplateImportOutput = z.output<
  typeof sandboxTemplateImport.output
>;
