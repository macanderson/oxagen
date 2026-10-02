// delivery.ts: the GitHub App's issue deliveries, handed to every work
// collector that reads the repository (P1-03, #5103; agent-work-phase-1.html,
// Work lifecycle: Collect).
//
// The GitHub App has one webhook URL for every installation
// (apps/api/src/routes/v1/github-webhook.ts). The route verifies the App's
// signature, then calls routeGithubWorkDelivery for an `issues` or
// `issue_comment` delivery. This finds the GitHub collectors whose connection
// belongs to the delivery's installation and whose scope names its repository,
// and runs the collector pipeline's doorbell for each, in that collector's own
// tenant scope:
//
// - verify the signature again, with the same App secret;
// - store the screened delivery once per collector, keyed by GitHub's delivery
//   id, so a redelivery stores nothing;
// - send one work/event.received event per stored delivery once every
//   collector has stored it. A paused collector stores the delivery and gets
//   no event.
//
// The item itself is fetched later, by id, so the webhook body never becomes a
// work item (pipeline.ts, Fetch).
import { schema, withSystemDb } from "@oxagen/database";
import {
  type CollectorRecord,
  type CollectorType,
  type DeliveryResult,
  type InboundRequest,
  receiveDelivery,
} from "@oxagen/ingestion/collectors";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { logger } from "../../logger";
import { scopeRepos } from "./collector-store";
import { sendWorkEvents } from "./handler-support";
import { intakePorts } from "./ports";

/** The GitHub events whose deliveries can name an issue. */
export const WORK_DELIVERY_EVENTS: ReadonlySet<string> = new Set(["issues", "issue_comment"]);

/** One work/event.received event the route sends. */
export interface WorkEventReceived {
  name: "work/event.received";
  id: string;
  data: { org_id: string; workspace_id: string; inbound_event_id: string };
}

/** What routing a delivery did, for the route's answer and log. */
export interface WorkDeliveryRouting {
  events: WorkEventReceived[];
  /** Collectors that stored the delivery. */
  stored: number;
  /** Collectors that had already stored this delivery id. */
  duplicates: number;
  /** Collectors whose verification refused the delivery. */
  rejected: number;
  /** Collectors that could not store the delivery. Their reconcile reads the issue. */
  failed: number;
}

/** What a delivery says about where it came from. */
export interface GithubDeliveryInput {
  installationId: string;
  /** owner/name, from the payload's repository. */
  repository: string;
  request: InboundRequest;
  /** The GitHub App's webhook secret, which signed the delivery. */
  secret: string;
}

/** The ports, the collector query, and the sender, so a test can run the routing without Postgres. */
export interface WorkDeliveryDeps {
  collectorsFor(installationId: string, repository: string): Promise<CollectorRecord[]>;
  receive: typeof receiveDelivery;
  ports: typeof intakePorts;
  send(events: readonly WorkEventReceived[]): Promise<void>;
}

/** The GitHub collectors whose connection belongs to the installation and whose scope names the repository. */
export async function githubCollectorsFor(installationId: string, repository: string): Promise<CollectorRecord[]> {
  const wanted = repository.toLowerCase();
  // tenancy: a signed webhook from the GitHub App names an installation, not an org,
  // so this reads collectors across tenants (cross-tenant), filtered by the verified
  // installation id; each match then runs scoped to its own org and workspace.
  const rows = await withSystemDb((tx) =>
    tx
      .select({ collector: schema.workCollectors })
      .from(schema.workCollectors)
      .innerJoin(
        schema.sourceConnections,
        and(
          eq(schema.sourceConnections.id, schema.workCollectors.connectionId),
          eq(schema.sourceConnections.orgId, schema.workCollectors.orgId),
          eq(schema.sourceConnections.workspaceId, schema.workCollectors.workspaceId),
        ),
      )
      .where(
        and(
          eq(schema.workCollectors.type, "github"),
          eq(schema.sourceConnections.connectorId, "github"),
          eq(schema.sourceConnections.status, "connected"),
          isNull(schema.sourceConnections.deletedAt),
          sql`${schema.sourceConnections.deliveryConfig} ->> 'installationId' = ${installationId}`,
          // A collector reads only repositories its workspace links. One the
          // workspace unlinked after the collector was set gets no delivery.
          exists(
            tx
              .select({ one: sql`1` })
              .from(schema.repositoryBindingHeads)
              .innerJoin(
                schema.repositoryBindings,
                eq(schema.repositoryBindings.id, schema.repositoryBindingHeads.currentBindingId),
              )
              .where(
                and(
                  eq(schema.repositoryBindingHeads.orgId, schema.workCollectors.orgId),
                  eq(schema.repositoryBindingHeads.workspaceId, schema.workCollectors.workspaceId),
                  eq(schema.repositoryBindingHeads.provider, "github"),
                  sql`lower(${schema.repositoryBindings.providerFullName}) = ${wanted}`,
                ),
              ),
          ),
        ),
      ),
  );
  return rows
    .map(({ collector }) => ({
      id: collector.id,
      orgId: collector.orgId,
      workspaceId: collector.workspaceId,
      name: collector.name,
      type: collector.type as CollectorType,
      connectionId: collector.connectionId,
      scope: collector.scope,
      health: collector.health as CollectorRecord["health"],
      cursor: collector.cursor,
      createdAt: collector.createdAt.toISOString(),
    }))
    .filter((collector) => scopeRepos(collector.scope).includes(wanted));
}

export const defaultWorkDeliveryDeps: WorkDeliveryDeps = {
  collectorsFor: githubCollectorsFor,
  receive: receiveDelivery,
  ports: intakePorts,
  send: sendWorkEvents,
};

/** Store one GitHub delivery for every collector that reads its repository. */
export async function routeGithubWorkDelivery(
  input: GithubDeliveryInput,
  deps: WorkDeliveryDeps = defaultWorkDeliveryDeps,
): Promise<WorkDeliveryRouting> {
  const routing: WorkDeliveryRouting = { events: [], stored: 0, duplicates: 0, rejected: 0, failed: 0 };
  for (const collector of await deps.collectorsFor(input.installationId, input.repository)) {
    const scope = { orgId: collector.orgId, workspaceId: collector.workspaceId };
    let result: DeliveryResult;
    try {
      result = await runInTenantScope(scope, () =>
        deps.receive(deps.ports(scope), { collector, request: input.request, secret: input.secret }),
      );
    } catch (err) {
      // One collector's failure must not drop the events of the collectors
      // that stored the delivery. This one's reconcile reads the issue.
      routing.failed += 1;
      logger.error({ err, collectorId: collector.id }, "work intake: a collector could not store a GitHub delivery; its reconcile reads the issue");
      continue;
    }
    switch (result.kind) {
      case "stored":
        routing.stored += 1;
        if (!result.paused) {
          routing.events.push({
            name: "work/event.received",
            id: `work-event-${result.inboundEventId}`,
            data: { org_id: scope.orgId, workspace_id: scope.workspaceId, inbound_event_id: result.inboundEventId },
          });
        }
        break;
      case "duplicate":
        routing.duplicates += 1;
        break;
      case "rejected":
        routing.rejected += 1;
        logger.warn({ collectorId: collector.id, reason: result.reason }, "work intake: a collector refused a GitHub delivery");
        break;
      default:
        logger.error({ collectorId: collector.id }, "work intake: no GitHub collector module is registered, so the delivery was not stored");
        break;
    }
  }
  if (routing.events.length > 0) await deps.send(routing.events);
  return routing;
}
