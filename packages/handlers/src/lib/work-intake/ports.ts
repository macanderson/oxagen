// ports.ts: the collector pipeline's ports in production (P1-03, #5103).
//
// - store: the Postgres collector store for one org and workspace.
// - screen: the credential screen (screen.ts) on every stored delivery and on
//   each item's subject, description, and requester.
// - connection: the collector's GitHub connection, as an installation token
//   minted for this call (resolveGitHubToken). The token is never stored.
// - no raw store: Oxagen keeps no unscreened bytes of a delivery. The signature
//   is checked on arrival, and the stored envelope is screened (ADR-250).
//
// Every port that reads Postgres must run inside runInTenantScope for the
// same org and workspace.
import { resolveGitHubToken } from "@oxagen/github/workspace-token";
import type { CollectorPorts, CollectorRecord, Connection } from "@oxagen/ingestion/collectors";
import { registerCollectorModules } from "@oxagen/ingestion/collectors";
import type { WorkScope } from "../work-records/store";
import { postgresCollectorStore } from "./collector-store";
import { screenValue } from "./screen";

/** The collector's connection with a credential minted for this call. Throws when there is none to use. */
export async function collectorConnection(scope: WorkScope, collector: CollectorRecord): Promise<Connection> {
  if (collector.type !== "github") {
    throw new Error(`Oxagen reads no ${collector.type} collector in this release. Only GitHub collectors run.`);
  }
  if (collector.connectionId === null) {
    throw new Error(`The collector ${collector.name} names no GitHub connection. Connect GitHub, then set the collector's connection.`);
  }
  const token = await resolveGitHubToken({ ...scope, connectionId: collector.connectionId });
  return { id: collector.connectionId, auth: { scheme: "bearer_token", token } };
}

/** The ports for one org and workspace. */
export function intakePorts(scope: WorkScope, now: () => Date = () => new Date()): CollectorPorts {
  registerCollectorModules();
  return {
    store: postgresCollectorStore(scope, now),
    async screen<T>(value: T) {
      return screenValue(value);
    },
    connection: (collector) => collectorConnection(scope, collector),
    now,
  };
}
