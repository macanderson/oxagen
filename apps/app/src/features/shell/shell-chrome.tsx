// The server half of the shell. It awaits the route params inside the
// <Suspense> the layout gives it (Cache Components: params of an unlisted slug
// are request data, so awaiting them at the layout's top would block the static
// shell), resolves the viewer (a stranger is a 404 before anything is read),
// reads through the port, and hands plain data to the client shell. The
// workspace slug is resolved by the workspace layout through requireViewer,
// from the tenancy lookups; the shell's context read plays no part in it.
import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { loadShellData } from "./load";
import { ShellClient } from "./shell-client";
import { shellSource } from "./source";

/** One load per request for the organization layout. */
const loadForOrg = cache(async (org: string) => {
  const { port, scope, userId } = await shellSource(org);
  return loadShellData(port, { org, scope, userId });
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
