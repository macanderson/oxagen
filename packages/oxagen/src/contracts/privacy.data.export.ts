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
  // Assembling the ZIP spends no AI credits, and the billing and budget gates
  // run before the handler. Without this an organisation that has exhausted
  // its credits or hit its spend ceiling could not export its data -- so the
  // one thing a customer needs most when their account is in trouble would be
  // the first thing to stop working, and GDPR Article 20 does not pause for an
  // unpaid invoice.
  noBillingGate: true,
  // `defaultEffect: "allow"`, for the same reason as `update_profile` and
  // `get_user_preferences` in this change: a person is never the wrong person
  // to export their own data. On an enterprise org -- the only tier the
  // resolver runs for -- the role map is the only thing between a member and
  // their own record, and the four system org roles are Owner, Admin,
  // Compliance and Billing. There is no org-level Member or Viewer:
  // `iam-provision` iterates the real role list and reads this map by name, so
  // naming roles that do not exist seeds no grant at all, and an invited member
  // holding no org role would still be refused at rule 8.
  //
  // `defaultEffect` is rule 8 of the resolver and role-agnostic, so no future
  // role can fall through it. Explicit denial still wins: rule 7 evaluates role
  // grants deny-first and hard-stops well before rule 8.
  //
  // `scope: "org"` is NOT governed here and cannot be -- the gate turns on an
  // input field, which `defaultRoles` cannot read. The handler re-reads the
  // caller's membership on the TARGET org and refuses a non-Owner/Admin with a
  // coded `forbidden`. That check is also the only one that holds when a
  // body-supplied `orgId` differs from `ctx.orgId`, which this layer resolves
  // against and would miss.
  defaultEffect: "allow",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
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
