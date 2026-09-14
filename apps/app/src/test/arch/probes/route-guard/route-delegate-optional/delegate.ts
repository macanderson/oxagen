export type Deps = {
  resolveViewer?: (org: string, ws: string) => Promise<{ kind: string }>;
};

export async function handle(
  _req: Request,
  params: { org: string; ws: string },
  deps: Deps,
): Promise<Response> {
  const result = await deps.resolveViewer?.(params.org, params.ws);
  return result?.kind === "not_found"
    ? Response.json({ code: "not_found" }, { status: 404 })
    : Response.json({});
}
