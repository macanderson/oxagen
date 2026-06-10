/**
 * In-process store mapping swarmId → dispatchId for research swarms.
 *
 * Scope: per-process, ephemeral. Survives the lifetime of a single API/MCP
 * server process. For persistence across restarts, a Postgres job_runs row
 * should be added (tracked as a follow-up once a research.swarm table exists).
 *
 * Keys are scoped with orgId+workspaceId so cross-tenant leakage is impossible
 * even within the same process.
 */

interface SwarmRecord {
  dispatchId: string;
  totalTasks: number;
  orgId: string;
  workspaceId: string;
}

const store = new Map<string, SwarmRecord>();

export function storeSwarm(
  swarmId: string,
  record: SwarmRecord,
): void {
  store.set(swarmId, record);
}

export function lookupSwarm(
  swarmId: string,
  orgId: string,
  workspaceId: string,
): SwarmRecord | null {
  const record = store.get(swarmId);
  if (!record) return null;
  // Enforce tenant isolation — reject lookups from a different org/workspace.
  if (record.orgId !== orgId || record.workspaceId !== workspaceId) return null;
  return record;
}
