// kill-switch-gate.ts — the tool gateway's kill-switch check (MC spec §6.11,
// §7.4 last row, ADR-072, #2958).
//
// A kill switch takes effect at the next call boundary through the deny
// generation: flipping one bumps `iam.authorization_deny_generations` in the
// same transaction (the table trigger), and every cached authorization is
// keyed by the generation it was computed under. This gate is that boundary
// for the tools a turn materializes. It holds the switches that were on when
// it last looked and the generation vector it looked under; before a
// non-read-only call runs it re-reads the vector, and when the vector moved it
// re-reads the switches.
//
// A read-only call is checked against what the gate last saw, and that is
// deliberate, not a shortcut. Spec §7.4's table for a deny-generation bump
// reads "non-read-only actions re-checked before they run" with the guarantee
// column "guaranteed for non-read-only tools" — the spec grants a read-only
// tool the turn's snapshot on purpose, because the cost of a vector read on
// every read is paid on the hottest path in the product for a call that
// changes nothing. A switch flipped mid-turn therefore stops every mutation at
// once and stops reads from the next turn. Widening this to an unconditional
// refresh is a spec change, not a bug fix; make it there first.
//
// Which switches reach a call is decided by `matchKillSwitch` in @oxagen/iam,
// the same matcher `list_tool_versions` prints the gate with. The facts a call
// carries: its capability id, the external server and connection it goes
// through, and the consequence tags of its registry version.
//
// A version's consequence tags live in TWO columns and a class switch reaches
// a tool tagged in either. `agent.tool_versions.consequence_tags` (text[]) is
// the declared half — what `publish_tool_declaration` and `import_tools` write
// from the descriptor, and what the mandate gate reads — and
// `classification->'consequenceTags'` is the classified half, what
// `set_tool_classification` writes. Both are drawn from the same vocabulary
// (`consequenceTagSchema`), so the index is their union: reading only the
// jsonb left every declared-tag tool outside every class switch's reach while
// `list_kill_switches` reported the switch on.
//
// This gate reaches every principal kind that materializes tools through
// `materializeTools` — the in-app agent's turn and the tool gateway. It is NOT
// the whole product's coverage: a customer agent calling a capability through
// the API or mcp.oxagen.sh with an API key never passes through here, and the
// kernel consults emergency denies only on the agent-run path
// (`checkAgentRunIAM`, packages/iam/src/check-iam.ts). `set_kill_switch`'s
// contract description and docs/capabilities/kill_switch.set.md state that
// coverage; do not widen the claim here without widening the enforcement.

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
import { and, eq, isNull } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import {
  registryCapabilityId,
  unionConsequenceTags,
} from "./tool-registry-facts";

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

async function readClassificationIndex(
  tx: Tx,
  scope: { orgId: string; workspaceId: string },
): Promise<ClassificationIndex> {
  // No `classification IS NOT NULL` filter: an unclassified version with
  // declared consequence tags is exactly the row a class switch has to reach.
  const rows = await tx
    .select({
      source: schema.tools.source,
      slug: schema.tools.slug,
      name: schema.tools.name,
      mcpServerId: schema.tools.mcpServerId,
      classification: schema.toolVersions.classification,
      consequenceTags: schema.toolVersions.consequenceTags,
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
      ),
    );
  const index = new Map<string, readonly string[]>();
  for (const row of rows) {
    const tags = unionConsequenceTags(row);
    if (tags.length === 0) continue;
    index.set(registryCapabilityId(row), tags);
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

/**
 * The managed agent a person's turn runs as in the record: the in-app
 * assistant's `qa-chat` agent (assistant-run.ts). That turn calls tools as the
 * person (ADR-053 §1) and carries no agent run, so without this a switch on
 * the agent would not reach it. IAM still checks the person. Only the
 * assistant's turn passes one: a person's own calls, and every other caller
 * of `materializeTools`, are not answerable to a switch on the assistant.
 */
export interface ActingAgent {
  /** The agent's public id (`agt_…`), the id an `agent` switch digests. */
  readonly agentId: string;
  /** Its IAM principal, once a turn has provisioned it; null before that. */
  readonly principalId: string | null;
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
 * gate re-enters it for its reads. `actingAgent` names the agent a person's
 * turn runs as, so a switch on that agent stops the turn's calls. An agent
 * run on the context takes precedence over it.
 */
export function createKillSwitchGate(
  ctx: CapabilityContext,
  reads: KillSwitchGateReads = postgresKillSwitchReads,
  actingAgent: ActingAgent | null = null,
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
      const agentRun =
        ctx.agentRun?.principalKind === "agent" ? ctx.agentRun : null;
      return matchKillSwitch(current.switches, {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        capabilityId: facts.capabilityId,
        serverId: facts.serverId ?? null,
        connectionId: facts.connectionId ?? null,
        consequenceTags: current.tags.get(facts.capabilityId) ?? [],
        agentId: agentRun?.agentId ?? actingAgent?.agentId ?? null,
        operatorUserId: ctx.userId ?? null,
        principalIds: agentRun
          ? [
              agentRun.agentPrincipal.id,
              ...(agentRun.humanPrincipal ? [agentRun.humanPrincipal.id] : []),
            ]
          : actingAgent?.principalId
            ? [actingAgent.principalId]
            : [],
      });
    },
  };
}
