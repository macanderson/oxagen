import { storage } from "@oxagen/storage";
import { handleExportDownload, readExportStatus } from "@/features/shell";
import { resolveViewer } from "@/server/viewer";

export const GET = (
  request: Request,
  context: RouteContext<"/[org]/account/export/[exportId]">,
): Promise<Response> =>
  handleExportDownload(request, context, {
    resolveViewer,
    readStatus: readExportStatus,
    storage,
  });
