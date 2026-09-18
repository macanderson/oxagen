import { storage } from "@oxagen/storage";
import { readExportStatus } from "@/features/shell/account-actions";
import { handleExportDownload } from "@/features/shell/export-download";
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
