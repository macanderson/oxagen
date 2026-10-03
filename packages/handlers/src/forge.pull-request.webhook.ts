// forge.pull-request.webhook.ts: what a GitHub App `pull_request` delivery
// asks of the pull request sync (ADR-288).
//
// The route verified the delivery's HMAC, so the payload is GitHub's word,
// and it carries everything the stored pull request needs: the repository's
// id, the number, the state, the head and base commits, and GitHub's
// `updated_at`. Each workspace connected to the delivering installation gets
// one `forge/pull-request.observed` event with those facts, so the sync
// writes the row without reading GitHub again. Only the diff of a head the
// workspace has not stored yet costs a read.
//
// A workspace that no connection for this installation names never learns a
// pull request's facts, the same fence the state writer keeps
// (github.pull-request.webhook.ts).
//
// The event id names the workspace, the pull request, its head, and GitHub's
// `updated_at`, so a redelivered delivery asks once and a new push or a new
// state asks again.
import { FORGE_PULL_REQUEST_OBSERVED_EVENT } from "@oxagen/inngest-functions/events";
import type { ForgePullRequestSyncRequest } from "@oxagen/inngest-functions/forge-pull-request-sync-runner";
import type { PullRequestStateScope } from "./github.pull-request.webhook";
import { githubDeliveryFacts, pullKeyOf } from "./lib/forge-pull-requests/facts";

export type ForgePullRequestObservedEvent = {
  name: typeof FORGE_PULL_REQUEST_OBSERVED_EVENT;
  id: string;
  data: ForgePullRequestSyncRequest;
};

/** One observed event per connected workspace, or none for an unreadable payload. */
export function githubObservedEvents(
  body: Record<string, unknown>,
  scopes: readonly PullRequestStateScope[],
): ForgePullRequestObservedEvent[] {
  const facts = githubDeliveryFacts(body);
  if (facts === null) return [];
  return scopes.map((scope) => ({
    name: FORGE_PULL_REQUEST_OBSERVED_EVENT,
    id: [
      "forge-pr-delivery",
      scope.workspaceId,
      "github",
      facts.providerRepositoryId,
      String(facts.number),
      facts.headSha,
      facts.sourceUpdatedAt ?? "undated",
    ].join(":"),
    data: {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      provider: "github",
      repository: facts.repository,
      number: facts.number,
      pullKey: pullKeyOf(
        scope.workspaceId,
        "github",
        facts.repository,
        facts.number,
      ),
      facts,
    },
  }));
}

export interface ForgePullRequestRequestDeps {
  /** The workspaces holding a connected GitHub source for this installation. */
  connectedScopes(installationId: string): Promise<PullRequestStateScope[]>;
  send(events: ForgePullRequestObservedEvent[]): Promise<unknown>;
}

/**
 * Ask the sync for every connected workspace's copy of the delivered pull
 * request. Answers how many events were sent. The route catches a failure
 * and never fails the delivery: the pull request's next delivery asks again.
 */
export async function requestForgePullRequestSync(
  deps: ForgePullRequestRequestDeps,
  args: { body: Record<string, unknown>; installationId: string },
): Promise<number> {
  if (githubDeliveryFacts(args.body) === null) return 0;
  const scopes = await deps.connectedScopes(args.installationId);
  const events = githubObservedEvents(args.body, scopes);
  if (events.length === 0) return 0;
  await deps.send(events);
  return events.length;
}
