// The signed export of the audit record (#3097): `GET /{org}/audit/export`.
// The route hands this its request, its params and the two seams it may use
// (ARCHITECTURE.md §2, INV-01): the viewer resolution as a value, so the
// handler writes its own response, and the data source, so the file comes from
// export_audit_events through kernelRead and from no other path.
//
// The filters are the page's filters, read from the same query string, so the
// file carries the rows the reader is looking at. The signature travels in the
// headers the deprecated route used, so a verifier written against it still
// works.
import "server-only";
import type { AuditExportFormat } from "@/data/contracts/audit";
import type { DataSource } from "@/data/ports";
import type { RouteViewer } from "@/server/viewer";
import { responseRedirect } from "@/shared/navigation";
import { routes } from "@/shared/safe-path";
import {
  auditQueryParams,
  auditWindow,
  parseAuditExportFormat,
  parseAuditQuery,
} from "./filters";

export type AuditExportDeps = {
  resolveViewer: (org: string) => Promise<RouteViewer>;
  dataSource: () => DataSource;
};

const CONTENT_TYPE: Record<AuditExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  ndjson: "application/x-ndjson; charset=utf-8",
};

function refusal(status: number, code: string): Response {
  return Response.json({ code }, { status });
}

export async function handleAuditExport(
  request: Request,
  context: { params: Promise<{ org: string }> },
  deps: AuditExportDeps,
): Promise<Response> {
  const { org } = await context.params;
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const format = parseAuditExportFormat(query) ?? "csv";
  const parsed = parseAuditQuery(query);
  const viewer = await deps.resolveViewer(org);
  switch (viewer.kind) {
    case "unauthenticated":
      return refusal(401, "unauthenticated");
    case "not_found":
      return refusal(404, "not_found");
    case "mfa_enroll":
      return refusal(403, "mfa_required");
    case "sso_required":
      return refusal(403, "sso_required");
    case "redirect":
      return responseRedirect(
        request,
        routes.auditExport(
          viewer.org,
          auditQueryParams(parsed, { offset: 0, format }),
        ),
        308,
      );
    case "ok":
      break;
  }
  const { offset: _offset, rows: _rows, ...filters } = parsed;
  // The same window the page reads over, resolved in the viewer's zone here so
  // the file carries the rows the reader is looking at (auditWindow).
  const source = deps.dataSource();
  const range = await auditWindow(viewer.ctx, source, filters, Date.now());
  const read = await source.audit.exportEvents(viewer.ctx, {
    ...range,
    format,
  });
  if (!read.ok) {
    if (read.reason === "denied") return refusal(403, "denied");
    if (read.reason === "pending_approval") {
      return refusal(403, "pending_approval");
    }
    return refusal(read.status, read.code);
  }
  const file = read.value;
  return new Response(file.body, {
    status: 200,
    headers: {
      "content-type": CONTENT_TYPE[file.format],
      "content-disposition": `attachment; filename="audit-events.${file.format}"`,
      "cache-control": "no-store",
      "X-Audit-Export-Signature": file.signature,
      "X-Audit-Export-Signature-Algorithm": file.algorithm,
      "X-Audit-Export-Row-Count": String(file.rowCount),
    },
  });
}
