"use server";
// Build bundle, the header's gold action on Audit (rev1 audit.md, Functionality:
// "Build bundle runs as export_data, a governed action with third-party
// egress"). It queues export_data with scope "org" for the organization the
// URL names and answers at once with the export id; the Exports tab then reads
// that export back by id with get_export_status and offers the download once
// it is ready.
//
// The archive is the organization's data export as one ZIP. The signed
// segment bundle the design describes, with attestations, key ids and the
// verifier, has no store for the organization yet (#3876), and the page says
// so beside the button rather than calling the ZIP that bundle.
//
// The organization id comes from the viewer, never from the input (INV-19):
// the handler re-reads the caller's membership on that organization and
// refuses anyone but an Owner or Admin with a coded `forbidden`.
import { privacyDataExport } from "@oxagen/oxagen/contracts/privacy.data.export";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type BundleQueued = { exportId: string };

export async function buildBundle(
  org: string,
): Promise<ActionResult<BundleQueued>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, privacyDataExport, {
    scope: "org",
    orgId: ctx.orgId,
  });
  return result.ok
    ? { ok: true, value: { exportId: result.value.exportId } }
    : result;
}
