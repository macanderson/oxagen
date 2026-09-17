// kill_switch.list.ts — handler for the list_kill_switches capability (#2958).
//
// audit-exempt: read-only. Lists the switches reaching this workspace — the
// org-wide class, operator, workspace and organisation switches and the
// workspace's own — with the current deny generation; the kernel's
// capability.invoke_* audit records the access. Flips are recorded by
// set_kill_switch.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { killSwitchList } from "@oxagen/oxagen/contracts/kill_switch.list";
import type { KillSwitchTarget } from "@oxagen/oxagen/contracts/kill_switch.set";
import type { DenyGenerationVector } from "@oxagen/oxagen/iam";
import { withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  readDenyGenerationVector,
  readKillSwitches,
  type KillSwitchRow,
} from "@oxagen/iam";

interface KillSwitchListDeps {
  read(scope: {
    orgId: string;
    workspaceId: string;
    onlyOn: boolean;
    limit: number;
  }): Promise<{ generation: DenyGenerationVector; rows: KillSwitchRow[] }>;
}

const postgresKillSwitchListDeps: KillSwitchListDeps = {
  read: (scope) =>
    withTenantDb(async (tx) => {
      const [generation, rows] = await Promise.all([
        readDenyGenerationVector(tx, {
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
        }),
        readKillSwitches(tx, scope),
      ]);
      return { generation, rows };
    }),
};

/** The row's target as the contract spells it; the row's kind is bounded by the CHECK. */
function targetOf(row: KillSwitchRow): KillSwitchTarget {
  return { kind: row.targetKind, id: row.targetId } as KillSwitchTarget;
}

export function createKillSwitchListHandler(
  deps: KillSwitchListDeps,
): CapabilityHandler<typeof killSwitchList> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      {
        org: ["Owner", "Admin", "Compliance"],
        workspace: ["Owner", "Member"],
      },
    );
    const { generation, rows } = await deps.read({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      onlyOn: input.onlyOn,
      limit: input.limit,
    });
    return {
      denyGeneration: generation,
      switches: rows.map((row) => ({
        id: row.publicId,
        target: targetOf(row),
        scope: row.scopeKind,
        on: row.active,
        reason: row.reason,
        flippedBy: row.flippedByUserId,
        flippedAt: row.activatedAt.toISOString(),
        clearedAt: row.deactivatedAt?.toISOString() ?? null,
        clearedBy: row.active ? null : row.updatedById,
      })),
    };
  };
}

export const killSwitchListHandler = createKillSwitchListHandler(
  postgresKillSwitchListDeps,
);
