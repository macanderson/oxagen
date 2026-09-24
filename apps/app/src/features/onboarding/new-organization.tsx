// /new-organization, onboarding step 1, as a Server Component: the signed-in
// person, then the gate shell around the organization form. A signed-out
// visitor is sent to /login and back here.
//
// Cancel goes to `/`, which opens the first workspace of an organization the
// person already belongs to, and brings someone with none back here: nothing
// is written until Continue.
import { headers } from "next/headers";
import { getAuthUser } from "@/server/session";
import { requireUser } from "@/server/viewer";
import { readNext, routes } from "@/shared/safe-path";
import { GateShell } from "./ui/gate-shell";
import { GateSkeleton } from "./ui/gate-states";
import { OrganizationForm } from "./ui/organization-form";

/** The host the address is printed under when the request names none. */
const FALLBACK_HOST = "app.oxagen.sh";

export async function NewOrganizationScreen({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Where a created organization continues to. /cli/authorize sends a new
  // account here with itself as the destination, so the CLI's PKCE round trip
  // finishes; with none, the form continues to the gate's Wrap an agent step.
  const next = readNext(await searchParams);
  await requireUser(routes.newOrganization(next));
  const [user, requestHeaders] = await Promise.all([getAuthUser(), headers()]);
  return (
    <GateShell
      step="organization"
      email={user?.email ?? null}
      cancel={routes.root()}
    >
      <OrganizationForm
        destination={next === routes.root() ? undefined : next}
        cancel={routes.root()}
        email={user?.email ?? null}
        host={requestHeaders.get("host") ?? FALLBACK_HOST}
      />
    </GateShell>
  );
}

/** The loading state: the shell and the rail stay, the card is the skeleton. */
export function NewOrganizationLoading() {
  return (
    <GateShell step="organization" email={null} cancel={routes.root()} pending>
      <GateSkeleton />
    </GateShell>
  );
}
