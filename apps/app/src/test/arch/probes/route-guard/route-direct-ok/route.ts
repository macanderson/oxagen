import { resolveViewer } from "@/server/viewer";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/probe/[org]/[ws]">,
): Promise<Response> {
  const { org, ws } = await ctx.params;
  const viewer = await resolveViewer(org, ws);
  return Response.json(viewer);
}
