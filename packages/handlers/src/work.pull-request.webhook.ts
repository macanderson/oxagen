// work.pull-request.webhook.ts: GitHub App deliveries about a pull request,
// recorded on every work order whose run linked it (P1-04, ADR-251).
//
// Two kinds of delivery reach a send after its run linked a pull request:
//
//   - `pull_request`: every send that linked the pull request records a new
//     head commit, a human merge with its merge commit, or a close without
//     merging. The delivery carries all three, so nothing is read back.
//   - `check_run`, `check_suite`, and `status`: a check changed on a commit.
//     Every open send whose pull request's current head is that commit reads
//     its evidence from GitHub again (`recordSendEvidence`): the checks the
//     base branch requires and every check's latest result. A delivery names
//     one check, and the review gate needs all of them, so the send records
//     GitHub's whole answer rather than the one check the delivery names.
//
// The GitHub App webhook route calls each of these once per verified delivery
// and never lets it fail the delivery. Each writes only workspaces connected
// to the delivering installation, and in each one only the sends the delivery
// concerns. A redelivery records nothing new, because each fact's dedupe key
// names what it says.
// audit-exempt: a provider delivery the route verified by HMAC, with no
// person or agent acting. Each fact names GitHub as its source.
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import type { OrderProjection } from "@oxagen/work/records";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { githubPullRequestStateDeps, type PullRequestStateScope } from "./github.pull-request.webhook";
import { githubEvidenceReader } from "./lib/work-records/evidence";
import { recordSendEvidence, recordWorkPullRequestDelivery, workPullRequestDeliveryOf } from "./lib/work-records/results";
import { readWorkItem, type WorkScope } from "./lib/work-records/store";

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

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

/** The commit a check delivery reports a result on. */
export interface WorkChecksDelivery {
  /** owner/name, in lower case. */
  repository: string;
  headSha: string;
}

/** One send a delivery concerns. */
export interface WorkOrderRef {
  itemId: string;
  orderId: string;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The actions that ask an App to run its checks again. They carry no result,
 * so they record nothing.
 */
const CHECK_REQUESTS: ReadonlySet<string> = new Set(["requested", "rerequested", "requested_action"]);

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The repository and commit a `check_run`, `check_suite`, or `status`
 * delivery reports a result on, or null when it reports none. A check run or
 * suite names its commit as `head_sha`, and a commit status as `sha`. Pure.
 */
export function workChecksDeliveryOf(body: Record<string, unknown>): WorkChecksDelivery | null {
  const fullName = objectOf(body["repository"])?.["full_name"];
  if (typeof fullName !== "string" || !fullName.includes("/")) return null;
  const action = body["action"];
  if (typeof action === "string" && CHECK_REQUESTS.has(action)) return null;
  const check = objectOf(body["check_run"]) ?? objectOf(body["check_suite"]);
  const sha = check !== null ? check["head_sha"] : body["sha"];
  if (typeof sha !== "string" || !COMMIT_SHA.test(sha)) return null;
  return { repository: fullName.toLowerCase(), headSha: sha };
}

/** The send is open, and its pull request is in the delivery's repository with its head at the delivery's commit. Pure. */
export function isOrderAtHead(order: Pick<OrderProjection, "closed" | "pullRequest" | "head">, delivery: WorkChecksDelivery): boolean {
  const pr = order.pullRequest;
  return !order.closed && pr !== null && pr.repository.toLowerCase() === delivery.repository && order.head === delivery.headSha;
}

/**
 * The open sends in the caller's scope whose pull request's current head is
 * the delivery's commit. A send that ever observed the commit is read, and its
 * projection decides: a later head on the same pull request moves the send
 * past this commit.
 */
export async function workOrdersAtHead(tx: Tx, scope: WorkScope, delivery: WorkChecksDelivery): Promise<WorkOrderRef[]> {
  const orders = schema.workOrders;
  const facts = schema.workItemFacts;
  const candidates = await tx
    .select({ itemId: orders.itemId, orderId: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.orgId, scope.orgId),
        eq(orders.workspaceId, scope.workspaceId),
        isNull(orders.closedAt),
        exists(
          tx
            .select({ one: sql`1` })
            .from(facts)
            .where(and(eq(facts.orderId, orders.id), eq(facts.kind, "head_observed"), eq(facts.headSha, delivery.headSha))),
        ),
      ),
    );
  const found: WorkOrderRef[] = [];
  for (const candidate of candidates) {
    const record = await readWorkItem(tx, scope, candidate.itemId);
    const order = record.projection.orders.find((entry) => entry.orderId === candidate.orderId);
    if (order !== undefined && isOrderAtHead(order, delivery)) found.push(candidate);
  }
  return found;
}

export interface WorkChecksWebhookDeps {
  connectedScopes(installationId: string): Promise<PullRequestStateScope[]>;
  /** The open sends in `scope` whose pull request's current head is the delivery's commit. */
  ordersAtHead(scope: WorkScope, delivery: WorkChecksDelivery): Promise<WorkOrderRef[]>;
  /** Read one send's evidence from GitHub and record it. Answers the facts recorded. */
  recordEvidence(scope: WorkScope, order: WorkOrderRef, now: Date): Promise<number>;
  now(): Date;
}

export const workChecksWebhookDeps: WorkChecksWebhookDeps = {
  connectedScopes: (installationId) => githubPullRequestStateDeps.connectedScopes(installationId),
  ordersAtHead: (scope, delivery) => runInTenantScope(scope, () => withTenantDb((tx) => workOrdersAtHead(tx, scope, delivery))),
  recordEvidence: (scope, order, now) =>
    runInTenantScope(scope, () => recordSendEvidence(scope, order.itemId, order.orderId, githubEvidenceReader, now)),
  now: () => new Date(),
};

/**
 * Record a check result on every open send whose pull request's current head
 * is the delivery's commit. Returns the number of facts recorded. One
 * workspace's or one send's failure does not stop the others; the failures
 * are thrown together for the route to log.
 */
export async function recordWorkOrderChecks(
  args: { body: Record<string, unknown>; installationId: string },
  deps: WorkChecksWebhookDeps = workChecksWebhookDeps,
): Promise<number> {
  const delivery = workChecksDeliveryOf(args.body);
  if (delivery === null) return 0;
  const scopes = await deps.connectedScopes(args.installationId);
  const now = deps.now();
  let recorded = 0;
  const failures: unknown[] = [];
  for (const scope of scopes) {
    let sends: WorkOrderRef[];
    try {
      sends = await deps.ordersAtHead(scope, delivery);
    } catch (error) {
      failures.push(error);
      continue;
    }
    for (const send of sends) {
      try {
        recorded += await deps.recordEvidence(scope, send, now);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `work.pull-request.webhook: ${failures.length} reads of the checks on ${delivery.repository}@${delivery.headSha} failed across ${scopes.length} workspaces; ${recorded} facts were recorded`,
    );
  }
  return recorded;
}
