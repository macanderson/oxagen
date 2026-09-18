/**
 * `get_export_status`: where a queued export has got to, and the link to it
 * once it is ready.
 *
 * `export_data` answers the moment it queues, with an id and the status
 * `queued`; the bundle is written later by
 * `packages/inngest-functions/src/functions/privacy.export.process.ts`, which
 * moves the row to `ready` and fills `export_url`. Without a read of that row
 * the id is all a person ever sees: the Account dialog's Privacy tab could
 * queue a bundle it could never hand over. GDPR Article 15 is a right to
 * receive the data, not a right to start a job.
 *
 * A status route already existed at `GET /v1/privacy/export/:exportId` and
 * queried `privacy.privacy_export_requests` directly, outside `invoke()`. A
 * user-facing read that skips the kernel has no IAM check, no audit row and no
 * entry in `check:manifest` or `check:ui-parity`, which is exactly how the
 * write beside it came to have no app surface for so long. The route now
 * dispatches this contract and the raw query is gone.
 *
 * `scoped: false` for the same reason as `export_data`: the row is keyed by
 * the person, and a bundle follows them rather than a workspace. The handler
 * matches on the principal's own user id, so one person can never read
 * another's export, whatever org either is in. The contract carries no user id
 * for the same reason `update_profile` carries none — a read that took a
 * target id would be a way to enumerate other people's bundles.
 *
 * A read of one's own request is never a governed action (ADR-052 exclusion
 * 2): `noBillingGate: true`. `defaultEffect: "allow"`, because a person is
 * never the wrong person to ask after their own export; rule 7 still lets an
 * enterprise admin deny a role explicitly, since role grants are evaluated
 * deny-first and hard-stop before rule 8 is reached. The role maps name
 * exactly the real roles at each scope — the four system org roles are Owner,
 * Admin, Compliance and Billing, and there is no org-level Member or Viewer.
 *
 * API only, no MCP surface, on `update_profile`'s reasoning: MCP builds every
 * context with `userId: null`, so this could only ever answer `forbidden`
 * there.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const exportStatusValues = [
  "queued",
  "processing",
  "ready",
  "failed",
] as const;

export const privacyDataExportStatus = registerCapability({
  name: "get_export_status",
  domain: "privacy",
  description:
    "Read the status of one of the calling user's own data exports, with the download link once it is ready.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: false,
  mutates: false,
  noBillingGate: true,
  sensitivity: "low",
  defaultEffect: "allow",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
    },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({ exportId: z.string().uuid() }).strict(),
  output: z
    .object({
      exportId: z.string(),
      status: z.enum(exportStatusValues),
      /** Set only once the status is `ready`. */
      downloadUrl: z.string().nullable(),
      completedAt: z.string().nullable(),
    })
    .strict(),
});

export type PrivacyDataExportStatusInput = z.output<
  typeof privacyDataExportStatus.input
>;
export type PrivacyDataExportStatusOutput = z.output<
  typeof privacyDataExportStatus.output
>;
