// tacho.memories.uses.record.ts: the memory files runs read on an enrolled
// host, and the memory files each full scan found there (ADR-248).
//
// The daemon's hook sees each Claude Code Read, Grep, and Bash call that
// names a memory file, and its memory reader lists every memory file at each
// scan. Every five minutes it sends both here. The handler checks the host
// key the way every Tacho control call does, then asks that the key's
// creator still holds a role the contract grants.
//
// A use names the run by its root session's uuid, because the host never
// learns the `tse_…` id. The handler reads that id from tacho.sessions, for
// this host's sessions only. A use whose session row has not landed yet comes
// back in `pending`, and the daemon sends it again. The store keeps one use
// per memory, run, and signal, and recomputes the memory's count from them.
//
// A count is a use the harness counted itself, such as the rise in Codex's
// `usage_count`. It has no run, so it is stored as a `harness_count` use with
// no run, and the store adds its count to the memory's.
//
// A scan retires each waiting or promoted memory of the host's agent from a
// file under the scan's folder that the scan did not find.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  tachoMemoryUsesRecord,
  type TachoMemoryUsesRecordOutput,
} from "@oxagen/oxagen/contracts/tacho.memories.uses.record";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import { assertContractRole } from "./lib/capability-role-guard";
import { resolveEnrolledHost } from "./lib/tacho-host";
import type {
  MemoryScanReport,
  MemoryScope,
  MemoryUseDraft,
} from "./memory/types";

const CAPABILITY = "record_tacho_memory_uses";

export interface TachoMemoryUsesRecordDeps {
  /**
   * The public id of each of the host's sessions among `sessionUuids`, keyed
   * by the session's uuid in lower case. A uuid with no row is left out.
   */
  runsOf(
    scope: MemoryScope,
    hostId: string,
    sessionUuids: string[],
  ): Promise<Map<string, string>>;
  /** Store uses (`recordUses` in memory/store). */
  recordUses(
    scope: MemoryScope,
    uses: MemoryUseDraft[],
  ): Promise<{ recorded: number; unknown: number }>;
  /** Retire what a full scan no longer found (`retireMissingSources` in memory/store). */
  retireMissing(
    scope: MemoryScope,
    scan: MemoryScanReport,
    at: Date,
  ): Promise<number>;
  now?(): Date;
}

/**
 * The sessions table and the Postgres memory store. The store loads on the
 * first call, so the handler module stays light for the route that
 * lazy-loads it.
 */
export const defaultTachoMemoryUsesRecordDeps: TachoMemoryUsesRecordDeps = {
  async runsOf(scope, hostId, sessionUuids) {
    const t = schema.tachoSessions;
    const rows = await withTenantDb((tx) =>
      tx
        .select({ sessionUuid: t.sessionUuid, publicId: t.publicId })
        .from(t)
        .where(
          and(
            eq(t.orgId, scope.orgId),
            eq(t.workspaceId, scope.workspaceId),
            eq(t.hostId, hostId),
            inArray(t.sessionUuid, sessionUuids),
          ),
        ),
    );
    return new Map(
      rows.map((row) => [row.sessionUuid.toLowerCase(), String(row.publicId)]),
    );
  },
  async recordUses(scope, uses) {
    const { postgresMemoryStore } = await import("./memory/store");
    return postgresMemoryStore.recordUses(scope, uses);
  },
  async retireMissing(scope, scan, at) {
    const { postgresMemoryStore } = await import("./memory/store");
    return postgresMemoryStore.retireMissingSources(scope, scan, at);
  },
};

export function createTachoMemoryUsesRecordHandler(
  deps: TachoMemoryUsesRecordDeps,
): CapabilityHandler<typeof tachoMemoryUsesRecord> {
  return async (input, ctx): Promise<TachoMemoryUsesRecordOutput> => {
    const host = await withTenantDb((tx) =>
      resolveEnrolledHost(CAPABILITY, ctx, tx as never, input.host_enrollment_id),
    );
    await assertContractRole(tachoMemoryUsesRecord, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const at = deps.now?.() ?? new Date();

    const sessions = [
      ...new Set(input.uses.map((use) => use.session_uuid.toLowerCase())),
    ];
    const runs =
      sessions.length === 0
        ? new Map<string, string>()
        : await deps.runsOf(scope, host.id, sessions);
    const pending: number[] = [];
    const uses: MemoryUseDraft[] = [];
    input.uses.forEach((use, index) => {
      const run = runs.get(use.session_uuid.toLowerCase());
      if (run === undefined) {
        pending.push(index);
        return;
      }
      // A host clock ahead of Oxagen's cannot stamp a use in the future.
      const usedAt = new Date(use.used_at);
      uses.push({
        capture: "local_gateway",
        source: `${use.harness}:${use.path}`,
        runPublicId: run,
        signal: "read",
        count: use.count,
        usedAt: usedAt > at ? at : usedAt,
      });
    });
    for (const count of input.counts) {
      const usedAt = new Date(count.used_at);
      uses.push({
        capture: "local_gateway",
        source: `${count.harness}:${count.path}`,
        runPublicId: null,
        signal: "harness_count",
        count: count.count,
        usedAt: usedAt > at ? at : usedAt,
      });
    }
    const { recorded, unknown } =
      uses.length === 0
        ? { recorded: 0, unknown: 0 }
        : await deps.recordUses(scope, uses);

    let retired = 0;
    for (const scan of input.scans) {
      retired += await deps.retireMissing(
        scope,
        {
          capture: "local_gateway",
          prefix: `${scan.harness}:${scan.root}`,
          seen: scan.paths.map((path) => `${scan.harness}:${path}`),
          agentLineage: host.agentKey,
        },
        at,
      );
    }
    return { recorded, unknown, pending, retired };
  };
}

export const tachoMemoryUsesRecordHandler = createTachoMemoryUsesRecordHandler(
  defaultTachoMemoryUsesRecordDeps,
);
