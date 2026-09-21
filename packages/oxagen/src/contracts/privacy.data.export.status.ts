/**
 * `get_export_status`: where a queued export has got to, and the key its
 * archive is served from once it is ready.
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
 * for the same reason `update_profile` carries none: a read that took a
 * target id would be a way to enumerate other people's bundles.
 *
 * An **organization** export is the exception, and the handler carries it.
 * `export_data` gates queueing one on Owner or Admin, a rule `defaultRoles`
 * cannot express because it turns on an input field. A queue is not a
 * download: the archive is assembled minutes later, and an Owner can be
 * demoted or removed in between. So the handler re-reads that authority at
 * read time for a row whose scope is "org", and refuses `forbidden` when it
 * is gone. A personal export is untouched.
 *
 * A read of one's own request is never a governed action (ADR-052 exclusion
 * 2): `noBillingGate: true`. `defaultEffect: "allow"`, because a person is
 * never the wrong person to ask after their own export; rule 7 still lets an
 * enterprise admin deny a role explicitly, since role grants are evaluated
 * deny-first and hard-stop before rule 8 is reached. The role maps name
 * exactly the real roles at each scope. The four system org roles are Owner,
 * Admin, Compliance and Billing, and there is no org-level Member or Viewer.
 *
 * MCP CLI-session credentials preserve the approving user. Machine credentials
 * with no user remain refused by the handler.
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
  // No URL is promised, because none is returned. The archive is a private
  // object, so the bytes come from an authenticated route that streams the
  // key this read answers with. A description saying "download link" sent a
  // generated client polling for a field that does not exist in the output
  // schema beside it, and the published schema is what those clients read.
  description:
    "Read the status of one of the calling user's own data exports. Answers a storage key rather than a URL: once ready, fetch the archive from GET /v1/{org}/{workspace}/privacy/export/{exportId}/download.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
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
      /**
       * Whether the bundle exists and can be fetched. The archive is written
       * as a **private** object (`access: "private"`), and the storage
       * contract is explicit that a private object's `url` is never rendered
       * in a browser: on Vercel Blob it needs the store's token, and on the
       * filesystem driver it is a key rather than a route. So no URL is
       * offered here at all. Bytes are served by an authenticated route
       * that streams `storage().get(storageKey)`.
       */
      ready: z.boolean(),
      /**
       * The canonical object key, for the serving route to read back. Null
       * until the bundle is written. It is an opaque path to the caller's own
       * object and grants nothing on its own: reading it needs the store's
       * credentials, which only the server holds.
       */
      storageKey: z.string().nullable(),
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
