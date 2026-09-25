import { handleAssistantStop, stopAssistantTurn } from "@/features/shell";
import { resolveViewer } from "@/server/viewer";

export const POST = (
  request: Request,
  context: RouteContext<"/[org]/[ws]/assistant/stop">,
): Promise<Response> =>
  handleAssistantStop(request, context, {
    resolveViewer,
    stopTurn: stopAssistantTurn,
  });
