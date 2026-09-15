// The server half of the shell. It awaits the route params inside the
// <Suspense> the layout gives it (Cache Components: params of an unlisted slug
// are request data, so awaiting them at the layout's top would block the static
// shell), resolves the viewer (a stranger is a 404 before anything renders),
// and hands plain data to the client shell. The workspace slug is resolved by
// the workspace layout through requireViewer, from the tenancy lookups.
import "server-only";
import { cache } from "react";
import { ShellClient } from "./shell-client";
import { shellSource } from "./source";

/** One viewer resolution per request for the organization layout. */
const loadForOrg = cache(shellSource);

export async function ShellChrome({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  return <ShellClient data={await loadForOrg(org)} />;
}
