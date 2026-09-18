import { z } from "zod";
import { registerCapability } from "../registry";

export const privacyDataExport = registerCapability({
  name: "export_data",
  domain: "privacy",
  description:
    "Request a machine-readable ZIP export of personal or organizational data (GDPR Article 20 — right to data portability). Returns immediately with status 'queued'; poll via GET /v1/privacy/export/:exportId for the download URL.",
  mode: "async",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "privacy" },
  sensitivity: "high",
  defaultEffect: "deny",
  // Every org member, because GDPR Article 20 is a right the person holds, not
  // a privilege an administrator grants: `scope: "user"` exports the caller's
  // own data and nothing else, and a member who cannot invoke this cannot
  // exercise it at all.
  //
  // `scope: "org"` stays Owner/Admin, enforced in the handler rather than here.
  // It has to be: the gate turns on an input field, which `defaultRoles` cannot
  // read. The handler re-reads the caller's membership on the TARGET org, so it
  // is also the only check that holds when a body-supplied `orgId` differs from
  // `ctx.orgId` -- this layer resolves roles against the context org and would
  // miss that entirely.
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Compliance: "allow",
      Billing: "allow",
      Viewer: "allow",
    },
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
