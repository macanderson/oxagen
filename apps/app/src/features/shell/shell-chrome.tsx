// The server half of the shell. The organization layout awaits the route
// params and resolves the viewer inside the <Suspense> the frame gives the
// chrome (a stranger is a 404 before anything renders); this hands plain data
// to the client shell.
//
// The chrome is a sibling of the page tree, not its ancestor, so it carries its
// own <TimeZoneProvider>: the account dialog and the user menu
// format dates too, and they must agree with the page below them.
// <ViewerClock> is the same provider around the pages.
//
// The approvals drawer shows the full approval card, which the Fleet page owns
// (fleet.md: "this spec owns the card and its dialogs"). A client module may
// not import another lane's barrel, so the card is rendered here, on the
// server, once per parked call, and handed to the drawer as an element: the
// same component Fleet and Run draw, so a call reads the same wherever it is
// decided, and its Approve and Deny are the same governed write.
import "server-only";
import type { ReactNode } from "react";
import type { DataSource } from "@/data/ports";
import { readOk } from "@/data/read";
import { ApprovalsPanel } from "@/features/fleet";
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
  const { data, cards: inputs } = await shellSource(ctx, source);
  const cards: Record<string, ReactNode> = {};
  for (const place of data.approvals.workspaces) {
    if (!place.pending.ok) continue;
    const mandates = inputs.mandates.get(place.slug) ?? new Map();
    for (const item of place.pending.value.items)
      cards[item.id] = (
        <ApprovalsPanel
          approvals={readOk({ items: [item], more: false })}
          mandates={mandates}
          now={data.approvals.readAt}
          org={data.org.slug}
          ws={place.slug}
        />
      );
  }
  return (
    <TimeZoneProvider timeZone={data.viewer.timeZone}>
      <ShellClient data={data} cards={cards} />
    </TimeZoneProvider>
  );
}
