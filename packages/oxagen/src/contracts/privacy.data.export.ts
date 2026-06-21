import { z } from "zod";
import { registerCapability } from "../registry";

export const privacyDataExport = registerCapability({
  name: "privacy.data.export",
  domain: "privacy",
  description:
    "Request a machine-readable ZIP export of personal or organizational data (GDPR Article 20 — right to data portability). Returns immediately with status 'queued'; poll via GET /v1/privacy/export/:exportId for the download URL.",
  mode: "async",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "privacy" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    /** "user" = current user's data only; "org" = full org export (Owner/Admin only). */
    scope: z.enum(["user", "org"]),
    /** Required when scope = "org". */
    orgId: z.string().uuid().optional(),
  }),
  output: z.object({
    exportId: z.string().uuid(),
    status: z.enum(["queued", "processing", "ready", "failed"]),
    /** Signed download URL — present only when status = "ready". */
    downloadUrl: z.string().url().optional(),
  }),
});

export type PrivacyDataExportInput = z.output<typeof privacyDataExport.input>;
export type PrivacyDataExportOutput = z.output<typeof privacyDataExport.output>;
