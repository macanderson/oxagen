// The server half of the shell. The organization layout awaits the route
// params and resolves the viewer inside the <Suspense> the frame gives the
// chrome (a stranger is a 404 before anything renders); this hands plain data
// to the client shell.
import "server-only";
import type { DataSource } from "@/data/ports";
import type { OrgCtx } from "@/server/viewer";
import { ShellClient } from "./shell-client";
import { shellSource } from "./source";

export async function ShellChrome({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  return <ShellClient data={await shellSource(ctx, source)} />;
}
