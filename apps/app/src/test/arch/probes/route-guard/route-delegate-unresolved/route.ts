import { resolveViewer } from "@/server/viewer";
import { handle } from "@oxagen/handlers/stream";

export async function GET(
  req: Request,
  ctx: RouteContext<"/api/probe/[org]/[ws]">,
): Promise<Response> {
  return handle(req, await ctx.params, { resolveViewer });
}
