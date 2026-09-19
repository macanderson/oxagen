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
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { inArray } from "drizzle-orm";
import {
  readDenyGenerationVector,
  readKillSwitches,
  type KillSwitchRow,
} from "@oxagen/iam";

/** A raw user id to the `usr_…` public id every other surface prints. */
type PublicIdOf = ReadonlyMap<string, string>;

interface KillSwitchListDeps {
  read(scope: {
    orgId: string;
    workspaceId: string;
    onlyOn: boolean;
    limit: number;
  }): Promise<{
    generation: DenyGenerationVector;
    rows: KillSwitchRow[];
    /** `flippedByUserId` / `updatedById` resolved to their `usr_…` public ids (#3147). */
    publicIdOf: PublicIdOf;
  }>;
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
      // Batch-resolve every user id the rows carry, one query for the page
      // rather than one per row: the same shape audit.shared.ts's join gives
      // `query_audit_log`, done here as a lookup because the rows already
      // came back from a separate read.
      const userIds = [
        ...new Set(
          rows
            .flatMap((r) => [r.flippedByUserId, r.updatedById])
            .filter((id): id is string => id !== null),
        ),
      ];
      const userRows =
        userIds.length === 0
          ? []
          : await tx
              .select({ id: schema.users.id, publicId: schema.users.publicId })
              .from(schema.users)
              .where(inArray(schema.users.id, userIds));
      const publicIdOf = new Map(userRows.map((u) => [u.id, u.publicId]));
      return { generation, rows, publicIdOf };
    }),
};

/** A row's raw user id, resolved to its `usr_…` public id; null when unset or unresolved. */
function publicIdOfUser(
  userId: string | null,
  publicIdOf: PublicIdOf,
): string | null {
  return userId === null ? null : (publicIdOf.get(userId) ?? null);
}

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
    const { generation, rows, publicIdOf } = await deps.read({
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
        flippedBy: publicIdOfUser(row.flippedByUserId, publicIdOf),
        flippedAt: row.activatedAt.toISOString(),
        clearedAt: row.deactivatedAt?.toISOString() ?? null,
        clearedBy: row.active
          ? null
          : publicIdOfUser(row.updatedById, publicIdOf),
      })),
    };
  };
}

export const killSwitchListHandler = createKillSwitchListHandler(
  postgresKillSwitchListDeps,
);
