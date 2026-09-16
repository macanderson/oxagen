// kill-switch-gate.ts — the tool gateway's kill-switch check (MC spec §6.11,
// §7.4 last row, ADR-068, #2958).
//
// A kill switch takes effect at the next call boundary through the deny
// generation: flipping one bumps `iam.authorization_deny_generations` in the
// same transaction (the table trigger), and every cached authorization is
// keyed by the generation it was computed under. This gate is that boundary
// for the tools a turn materializes. It holds the switches that were on when
// it last looked and the generation vector it looked under; before a
// non-read-only call runs it re-reads the vector, and when the vector moved it
// re-reads the switches. A read-only call is checked against what the gate
// last saw (§7.4: "non-read-only actions re-checked before they run").
//
// Which switches reach a call is decided by `matchKillSwitch` in @oxagen/iam,
// the same matcher `list_tool_versions` prints the gate with. The facts a call
// carries: its capability id, the external server and connection it goes
// through, and the consequence tags of its registry version — read from
// `agent.tool_versions.classification` the same time the switches are.
//
// The gate applies to every principal kind. The kernel's agent-run IAM check
// enforces emergency denies on its own path; a human's chat turn has no such
// path, and a kill switch is not an enterprise feature.

import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { withRepeatableReadTenantDb } from "@oxagen/database/tenant";
import {
  matchKillSwitch,
  readActiveKillSwitches,
  readDenyGenerationVector,
  type KillSwitchRow,
} from "@oxagen/iam";
import type { DenyGenerationVector } from "@oxagen/oxagen/iam";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { CapabilityContext } from "../types";

/** What the gate knows about one call beyond the run's own scope. */
interface ToolCallFacts {
  /** The capability id the call is governed under (`mcp.<server>.<tool>` for an external tool). */
  readonly capabilityId: string;
  readonly serverId?: string | null;
  readonly connectionId?: string | null;
  /** True when the tool does not mutate; checked against the last-read switches, no refresh. */
  readonly readOnly: boolean;
}

/** The consequence tags of every classified active version, by capability id. */
type ClassificationIndex = ReadonlyMap<string, readonly string[]>;

export interface KillSwitchSnapshot {
  readonly generation: DenyGenerationVector;
  readonly switches: readonly KillSwitchRow[];
  readonly tags: ClassificationIndex;
}

/** The reads the gate makes; injectable for tests. */
export interface KillSwitchGateReads {
  readGeneration(scope: {
    orgId: string;
    workspaceId: string;
  }): Promise<DenyGenerationVector>;
  readSnapshot(scope: {
    orgId: string;
    workspaceId: string;
  }): Promise<KillSwitchSnapshot>;
}

/** The capability id a registry row is governed under. */
export function registryCapabilityId(row: {
  source: string;
  slug: string;
  name: string;
  mcpServerId: string | null;
}): string {
  return row.source === "mcp" && row.mcpServerId
    ? `mcp.${row.mcpServerId}.${row.name}`
    : row.slug;
}

async function readClassificationIndex(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
): Promise<ClassificationIndex> {
  const rows = await tx
    .select({
      source: schema.tools.source,
      slug: schema.tools.slug,
      name: schema.tools.name,
      mcpServerId: schema.tools.mcpServerId,
      classification: schema.toolVersions.classification,
    })
    .from(schema.tools)
    .innerJoin(
      schema.toolVersions,
      eq(schema.toolVersions.id, schema.tools.activeVersionId),
    )
    .where(
      and(
        eq(schema.tools.orgId, scope.orgId),
        eq(schema.tools.workspaceId, scope.workspaceId),
        isNull(schema.tools.deletedAt),
        isNotNull(schema.toolVersions.classification),
      ),
    );
  const index = new Map<string, readonly string[]>();
  for (const row of rows) {
    const tags = (row.classification as { consequenceTags?: unknown } | null)
      ?.consequenceTags;
    if (!Array.isArray(tags)) continue;
    index.set(
      registryCapabilityId(row),
      tags.filter((t): t is string => typeof t === "string"),
    );
  }
  return index;
}

export const postgresKillSwitchReads: KillSwitchGateReads = {
  readGeneration: (scope) =>
    withTenantDb((tx) =>
      readDenyGenerationVector(tx, {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
      }),
    ),
  // The vector, the switches and the index are read on one MVCC snapshot.
  // Read on separate transactions, a flip committing between them would pair
  // a post-flip generation with pre-flip switches, and every later check
  // would find the generation unchanged and keep the stale switches for the
  // rest of the turn (the hazard packages/iam/src/authorization-snapshot.ts
  // documents for the grant ceiling).
  readSnapshot: (scope) =>
    withRepeatableReadTenantDb(async (tx) => {
      const generation = await readDenyGenerationVector(tx, {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
      });
      const switches = await readActiveKillSwitches(tx, {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
      });
      const tags = await readClassificationIndex(tx, scope);
      return { generation, switches, tags };
    }),
};

export class KillSwitchDeniedError extends Error {
  readonly code = "kill_switch";
  constructor(readonly hit: KillSwitchRow) {
    super(
      `Tool blocked by kill switch (${hit.targetKind} ${hit.targetId}): ${hit.reason}`,
    );
    this.name = "KillSwitchDeniedError";
  }
}

export interface KillSwitchGate {
  /**
   * The switch that stops this call, or null when it is open. A
   * non-read-only call re-reads the deny generation first; a moved generation
   * reloads the switches and the classification index.
   */
  check(facts: ToolCallFacts): Promise<KillSwitchRow | null>;
}

function sameGeneration(a: DenyGenerationVector, b: DenyGenerationVector) {
  return a.org === b.org && a.workspace === b.workspace;
}

/**
 * One gate per materialization, sharing one snapshot across every tool of
 * the turn. The execute closures run outside the route's tenant scope, so the
 * gate re-enters it for its reads.
 */
export function createKillSwitchGate(
  ctx: CapabilityContext,
  reads: KillSwitchGateReads = postgresKillSwitchReads,
): KillSwitchGate {
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  let snapshot: KillSwitchSnapshot | null = null;
  let loading: Promise<KillSwitchSnapshot> | null = null;

  const inScope = <T>(fn: () => Promise<T>) =>
    runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, fn);

  const load = (): Promise<KillSwitchSnapshot> => {
    loading ??= inScope(() => reads.readSnapshot(scope)).then(
      (s) => {
        snapshot = s;
        loading = null;
        return s;
      },
      (err: unknown) => {
        loading = null;
        throw err;
      },
    );
    return loading;
  };

  return {
    async check(facts) {
      let current = snapshot ?? (await load());
      if (!facts.readOnly) {
        const generation = await inScope(() => reads.readGeneration(scope));
        if (!sameGeneration(generation, current.generation)) {
          current = await load();
        }
      }
      if (current.switches.length === 0) return null;
      const agentRun = ctx.agentRun;
      return matchKillSwitch(current.switches, {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        capabilityId: facts.capabilityId,
        serverId: facts.serverId ?? null,
        connectionId: facts.connectionId ?? null,
        consequenceTags: current.tags.get(facts.capabilityId) ?? [],
        agentId: agentRun?.principalKind === "agent" ? agentRun.agentId : null,
        operatorUserId: ctx.userId ?? null,
        principalIds:
          agentRun?.principalKind === "agent"
            ? [
                agentRun.agentPrincipal.id,
                ...(agentRun.humanPrincipal
                  ? [agentRun.humanPrincipal.id]
                  : []),
              ]
            : [],
      });
    },
  };
}
