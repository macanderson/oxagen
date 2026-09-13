// GET /api/mc/{org}/{ws}/stream — the one SSE route (plan §4.9). All logic
// lives in src/server/stream-route.ts, where it is unit tested.
import { resolveViewer } from "@/server/scope";
import { streamFeeds } from "@/server/stream-feeds";
import { handleStreamRequest, reportStreamError } from "@/server/stream-route";

export async function GET(
  req: Request,
  ctx: RouteContext<"/api/mc/[org]/[ws]/stream">,
): Promise<Response> {
  return handleStreamRequest(req, await ctx.params, {
    resolveViewer,
    feeds: streamFeeds,
    onError: reportStreamError,
  });
}
