import { z } from "zod";
import { defineTool } from "./_define";
import { exportDataFields, privacyDataExport } from "../privacy.data.export";

/**
 * Appendix E: `export_data` — "organization export". Absorbs `export_data`.
 *
 * The name carries and the scope narrows. v1's `export_data` was one capability
 * for every kind of export; Appendix E splits the job three ways, and the other
 * two rows say so explicitly: `export_run` takes "export_data (run part)" and
 * returns a signed bundle with a verifier, and `export_statement` takes
 * "export_data (billing part)". What is left here is the organization export,
 * which is what the Does column says and what §14's org Audit page lists among
 * its actions.
 *
 * So the only field-level change is the one that follows from that: `scope`
 * carries by import and is narrowed with `.extract(["org"])` rather than being
 * re-declared, so the field keeps its identity and the narrowing is visible as
 * a narrowing. `orgId` was optional with "required when scope = 'org'" in a
 * doc comment; with `user` gone the condition is always true, so the spec makes
 * required what the comment only asked for.
 *
 * §13.4 adds the verifier: "Exports produce a verifiable bundle: segments,
 * attestations, key ids, and a verifier script." An export the recipient cannot
 * check is a zip file, not evidence, so the script ships with the download
 * rather than being described in documentation somewhere.
 */

export const exportData = defineTool({
  name: "export_data",
  domain: "audit",
  description:
    "Request a machine-readable export of the organization's data as a verifiable bundle — archive segments, attestations, key ids, and a verifier script (§13.4). Returns immediately with status 'queued'; poll get_export_status until it reports ready, then fetch the bundle from the authenticated download route. No response carries a download URL.",
  // Carried: building an org-wide bundle is not a request-path operation, and
  // the caller is handed a request id to poll rather than a held connection.
  mode: "async",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["export_data"],
  drops: [
    {
      field: "scope.user",
      from: "export_data",
      why: "Appendix E narrows this tool to 'organization export' and gives the other halves their own rows — export_run for the run part (a signed bundle with a verifier) and export_statement for the billing part. The enum literal is dropped; the field itself carries",
    },
  ],

  // Single source and a narrower job, so every governance field carries
  // unchanged. Sensitivity stays high: the bundle is the organization's data.
  agent: { requiresApproval: false, riskLevel: "low", category: "privacy" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    // Carried. Empty at workspace scope, which is also where §14 puts Audit —
    // one of the three organization-scope pages.
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  // Writes an export request row and emits the job event that builds the
  // bundle (the v1 handler inserts into privacy export requests, then sends).
  mutates: true,

  input: z.object({
    /**
     * Carried and narrowed — see the header. Kept as a field rather than
     * removed so the request stays self-describing in the audit record: an
     * export event that does not say what was exported ages badly.
     */
    scope: exportDataFields.shape.scope.extract(["org"]),
    /**
     * Carried, now required. v1 made it optional with "required when scope =
     * 'org'" in a comment; with `user` gone the condition always holds, so the
     * schema enforces what the comment asked for.
     */
    orgId: exportDataFields.shape.orgId.unwrap(),
  }),

  output: z.object({
    // Carried: the request handle and its lifecycle, unchanged.
    exportId: privacyDataExport.output.shape.exportId,
    status: privacyDataExport.output.shape.status,
    /**
     * Carried, and carried as what it now is: never set. The v1 field's
     * description says so, but a v2 client reads this shape, so repeating it
     * here is the difference between a field it knows to ignore and one it
     * waits for. The bundle is a private object, so there is no URL to sign:
     * `get_export_status` answers a storage key and the bytes come from the
     * authenticated download route. Kept only so an older client parsing this
     * shape does not break on its absence.
     */
    downloadUrl: privacyDataExport.output.shape.downloadUrl,

    /**
     * §13.4, new. The verifier script that checks the bundle's Merkle roots and
     * attestation signatures against the named key ids. It ships beside the
     * download because a bundle nobody can verify proves nothing, and the
     * recipient is usually the customer's auditor rather than the caller.
     */
    verifierUrl: z.string().url().optional(),
  }),
});

export type ExportDataInput = z.output<typeof exportData.input>;
export type ExportDataOutput = z.output<typeof exportData.output>;
