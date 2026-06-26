/**
 * Async event emitters for Engram background workers.
 *
 * After a memory record is written to the episodic store, these fire Inngest
 * events for:
 * - Graph sync (Neo4j :REMEMBERS/:ABOUT edges)
 * - Embedding generation (vector for ANN retrieval)
 *
 * The event client is injected (not hard-wired) so the engram package doesn't
 * depend on @oxagen/inngest-functions at the package level. The agent runtime
 * supplies the concrete EventClient at boot time.
 */

export interface GraphSyncEvent {
  name: "engram/memory.graph-sync";
  data: {
    recordId: string;
    orgId: string;
    workspaceId: string;
    nodeRef?: string | null;
    entityRefs?: string[] | null;
    body: string;
    kind: string;
    salience: number;
  };
}

export interface EmbedEvent {
  name: "engram/memory.embed";
  data: {
    recordId: string;
    orgId: string;
    workspaceId: string;
    kind: string;
    body: string;
  };
}

type EngramEvent = GraphSyncEvent | EmbedEvent;

/**
 * Minimal event client interface — matches @oxagen/functions EventClient.
 */
export interface GraphSyncEventClient {
  send(event: EngramEvent): Promise<void>;
}

/**
 * Module-level event client. Set once at surface bootstrap.
 * If not set, events are silently dropped (graceful degradation).
 */
let _client: GraphSyncEventClient | null = null;

/**
 * Inject the event client. Call once at surface startup
 * (API boot, CLI init, etc.) after the Inngest client is ready.
 */
export function setGraphSyncClient(client: GraphSyncEventClient): void {
  _client = client;
}

/**
 * Clear the client (for tests).
 */
export function clearGraphSyncClientForTests(): void {
  _client = null;
}

/**
 * Fire a graph sync event. Best-effort — never throws.
 */
export async function emitGraphSync(
  data: GraphSyncEvent["data"],
): Promise<void> {
  if (!_client) return;
  try {
    await _client.send({ name: "engram/memory.graph-sync", data });
  } catch {
    // Best-effort: the engram record is the durable source of truth.
  }
}

/**
 * Fire an embed event. Best-effort — never throws.
 */
export async function emitEmbedEvent(data: EmbedEvent["data"]): Promise<void> {
  if (!_client) return;
  try {
    await _client.send({ name: "engram/memory.embed", data });
  } catch {
    // Best-effort: embedding will be missing until backfill.
  }
}
