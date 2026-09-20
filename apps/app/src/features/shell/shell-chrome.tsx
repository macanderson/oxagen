// The server half of the shell. The organization layout awaits the route
// params and resolves the viewer inside the <Suspense> the frame gives the
// chrome (a stranger is a 404 before anything renders); this hands plain data
// to the client shell.
//
// The chrome is a sibling of the page tree, not its ancestor, so it carries its
// own <TimeZoneProvider>: the account dialog and the user menu
// format dates too, and they must agree with the page below them.
// <ViewerClock> is the same provider around the pages.
import "server-only";
import type { DataSource } from "@/data/ports";
import type { OrgCtx } from "@/server/viewer";
import { ShellClient } from "./shell-client";
import { shellSource } from "./source";
import { TimeZoneProvider } from "./time-zone-provider";

export async function ShellChrome({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  const data = await shellSource(ctx, source);
  return (
    <TimeZoneProvider timeZone={data.viewer.timeZone}>
      <ShellClient data={data} />
    </TimeZoneProvider>
  );
}
