/**
 * Fleet: every machine enrolled in this workspace, and — the point of the
 * screen — what Oxagen actually records for each app on it (ADR-078).
 *
 * `harnesses` alone says which apps a machine has and nothing about what that
 * coverage means, and the two tiers mean very different things:
 *
 *   wrapped   (`harness`) — a hook sees every action the agent takes,
 *             including its own commands and file edits. Oxagen does not run
 *             the process, so the record is what the agent reported.
 *   connected (`gateway`) — no hook exists. Oxagen serves the app a toolbelt
 *             and refuses, on the server, the calls its mandate does not
 *             allow. It sees nothing else the app does.
 *
 * Neither is the better one, so nothing here ranks them: no progress bar, no
 * "fully/partially governed", no count that adds them together. Each row says
 * what it records and what it does not.
 */

import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspaceOrRedirect } from "@/lib/resolve-org";
import { type FleetHost, listFleetAction } from "./actions";

// No route segment config. `cacheComponents` (apps/app/next.config.mjs)
// replaces `dynamic`/`revalidate` and fails the build on a segment that still
// declares one, which is what `dynamic = "force-dynamic"` here did. Removing it
// does not risk a stale prerender: nothing on this page opts into `use cache`,
// and every read below is uncached runtime IO — the session cookie, the org and
// workspace lookups, `listFleetAction` — so under Cache Components the whole
// fleet itself is server-rendered on every request, which is what
// force-dynamic was asking for. The Suspense boundary that build-time
// enforcement requires around that IO is the parent segment's
// `[workspaceSlug]/loading.tsx`, which wraps this page as the layout's
// children; the build reports the route as ◐ (partial prerender), meaning the
// shell is static and the fleet streams in behind that boundary. A stale fleet
// is a wrong fleet, so if this page ever grows a cached read, cache the read —
// never the page.

/** What each tier records, and what it does not. Both lines, always. */
const TIER_COPY = {
  harness: {
    label: "Wrapped",
    records:
      "Every action this agent takes, including the commands it runs and the files it changes.",
    omits:
      "Oxagen does not run this agent, so the record is what the agent reported.",
  },
  gateway: {
    label: "Connected",
    records: "The Oxagen tools this app calls, and the ones it was refused.",
    omits:
      "Not prompts, not model calls, and nothing this app does through any other tool.",
  },
} as const;

function lastSeen(host: FleetHost): string {
  if (host.lastSeenAt === null) return "never";
  const ms = Date.now() - Date.parse(host.lastSeenAt);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default async function FleetPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const workspace = await resolveWorkspaceOrRedirect(
    org.id,
    orgSlug,
    workspaceSlug,
    `/${orgSlug}/${workspaceSlug}/fleet`,
    "",
  );

  const result = await listFleetAction({
    orgSlug,
    workspaceSlug: workspace.slug,
  });

  return (
    <div className="space-y-6" data-testid="fleet-page">
      <div>
        <h1 className="text-2xl font-semibold text-app-panel-fg">Fleet</h1>
        <p className="mt-1 text-sm text-app-link-fg">
          The machines reporting to this workspace, and what Oxagen records for
          each app on them. A <strong>wrapped</strong> app runs an Oxagen hook;
          a <strong>connected</strong> app is served its tools through the
          Oxagen gateway. Neither covers what the other covers.
        </p>
      </div>

      {!result.ok ? (
        <Panel>
          <p className="text-sm text-destructive" data-testid="fleet-error">
            {result.error}
          </p>
        </Panel>
      ) : result.hosts.length === 0 ? (
        <Panel>
          <p className="text-sm text-app-link-fg" data-testid="fleet-empty">
            No machines are enrolled in this workspace yet. Install the Oxagen
            desktop app on a machine and sign in to put its AI apps under this
            workspace.
          </p>
        </Panel>
      ) : (
        <div className="space-y-4" data-testid="fleet-hosts">
          {result.hosts.map((host) => (
            <Panel key={host.hostEnrollmentId}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium text-app-panel-fg">
                  {host.hostname}
                </span>
                <Badge
                  variant={host.status === "active" ? "default" : "secondary"}
                >
                  {host.status}
                </Badge>
                <span className="text-xs text-app-link-fg">
                  {host.platform} · {host.osUser} · last seen {lastSeen(host)}
                </span>
                {host.incidentsOpen > 0 ? (
                  <Badge variant="destructive">
                    {host.incidentsOpen} open incident
                    {host.incidentsOpen === 1 ? "" : "s"}
                  </Badge>
                ) : null}
              </div>

              <ul className="mt-4 space-y-3">
                {host.harnesses.map((harness) => {
                  // An unknown harness is filed as wrapped by the handler,
                  // which is the tier that carries the attestation caveat.
                  const tier = host.tiers[harness] ?? "harness";
                  const copy = TIER_COPY[tier];
                  return (
                    <li
                      key={harness}
                      className="rounded-md border border-app-topbar-border p-3"
                      data-testid={`fleet-harness-${harness}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-app-panel-fg">
                          {harness}
                        </span>
                        <Badge
                          variant="outline"
                          data-testid={`fleet-tier-${harness}`}
                        >
                          {copy.label}
                        </Badge>
                      </div>
                      {/*
                        Both lines, always. A row that shows only what a tier
                        records reads as coverage it does not have.
                      */}
                      <p className="mt-1 text-xs text-app-link-fg">
                        Records: {copy.records}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {copy.omits}
                      </p>
                    </li>
                  );
                })}
              </ul>

              <p className="mt-3 text-xs text-app-link-fg">
                {host.sessionsCount} session
                {host.sessionsCount === 1 ? "" : "s"} recorded
                {host.unobservedSessionsCount > 0
                  ? ` · ${host.unobservedSessionsCount} session${host.unobservedSessionsCount === 1 ? "" : "s"} ran without reporting`
                  : ""}
              </p>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
