// The server half of the shell. Each piece awaits the route params inside the
// <Suspense> the layout gives it (Cache Components: params of an unlisted slug
// are request data, so awaiting them at the layout's top would block the static
// shell), reads through the port, and hands plain data to the client shell.
import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { loadShellData, workspaceExists } from "./load";
import { ShellClient } from "./shell-client";
import { shellSource } from "./source";

/** One load per request, shared by the organization layout and the workspace guard. */
const loadForOrg = cache(async (org: string) => {
  const { port, userId } = await shellSource();
  return loadShellData(port, { org, userId: userId ?? "" });
});

export async function ShellChrome({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const load = await loadForOrg(org);
  if (load.kind === "not_found") notFound();
  return <ShellClient data={load.data} />;
}

/** The workspace layout's guard: an unknown workspace slug is a 404, like an unknown organization. */
export async function WorkspaceGuard({
  params,
}: {
  params: Promise<{ org: string; ws: string }>;
}) {
  const { org, ws } = await params;
  const load = await loadForOrg(org);
  if (load.kind === "not_found" || workspaceExists(load.data, ws) === false)
    notFound();
  return null;
}
