// work.pull-request.webhook.ts: a GitHub `pull_request` delivery, recorded on
// every work order whose run linked the pull request (P1-04, ADR-251).
//
// The GitHub App webhook route calls this beside `recordGithubPullRequestState`
// once per verified delivery, and never lets it fail the delivery. It writes
// only workspaces connected to the delivering installation, and in each one
// only the sends that linked this pull request: a new head commit, a human
// merge with its merge commit, or a close without merging. A redelivery
// records nothing new, because each fact's dedupe key names what it says.
// audit-exempt: a provider delivery the route verified by HMAC, with no
// person or agent acting. Each fact names GitHub as its source.
import { githubPullRequestStateDeps, type PullRequestStateScope } from "./github.pull-request.webhook";
import { recordWorkPullRequestDelivery, workPullRequestDeliveryOf } from "./lib/work-records/results";

export interface WorkPullRequestWebhookDeps {
  connectedScopes(installationId: string): Promise<PullRequestStateScope[]>;
  record: typeof recordWorkPullRequestDelivery;
  now(): Date;
}

export const workPullRequestWebhookDeps: WorkPullRequestWebhookDeps = {
  connectedScopes: (installationId) => githubPullRequestStateDeps.connectedScopes(installationId),
  record: recordWorkPullRequestDelivery,
  now: () => new Date(),
};

/**
 * Record the delivery on the work orders that linked its pull request.
 * Returns the number of facts recorded. One workspace's failure does not
 * stop the others; the failures are thrown together for the route to log.
 */
export async function recordWorkOrderPullRequest(
  args: { body: Record<string, unknown>; installationId: string },
  deps: WorkPullRequestWebhookDeps = workPullRequestWebhookDeps,
): Promise<number> {
  const delivery = workPullRequestDeliveryOf(args.body);
  if (delivery === null) return 0;
  const scopes = await deps.connectedScopes(args.installationId);
  const now = deps.now();
  let recorded = 0;
  const failures: unknown[] = [];
  for (const scope of scopes) {
    try {
      recorded += await deps.record(scope, delivery, now);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `work.pull-request.webhook: ${failures.length} of ${scopes.length} workspaces could not record the pull request`);
  }
  return recorded;
}
