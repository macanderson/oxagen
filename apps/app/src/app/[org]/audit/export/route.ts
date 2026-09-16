import { dataSource } from "@/data/source";
import { handleAuditExport } from "@/features/audit";
import { resolveViewer } from "@/server/viewer";

export const GET = (
  request: Request,
  context: RouteContext<"/[org]/audit/export">,
): Promise<Response> =>
  handleAuditExport(request, context, { resolveViewer, dataSource });
