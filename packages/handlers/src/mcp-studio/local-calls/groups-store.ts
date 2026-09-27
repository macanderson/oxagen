// groups-store.ts: machine groups in Postgres (mcp-studio-spec, Local servers,
// Machines).
//
// One tacho.machine_group_members row puts one enrolled machine (a
// tacho.hosts row) in one group. A group has no row of its own, so it exists
// while one machine is in it. The cloud gateway reads a machine's groups
// through `postgresMachineGroupReader` before it signs an envelope. The three
// capabilities change and list them through `postgresMachineGroupStore`.
//
// A machine is named by its enrollment id, the host's public id (`tch_…`),
// which the machine's host file holds. Every read and write filters by the
// caller's org and workspace as well as running under row-level security, so
// a machine enrolled in another workspace reads as not enrolled.
import { HandlerError } from "@oxagen/oxagen";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, eq, ne } from "drizzle-orm";
import type { MachineGroupReader, MachineScope } from "./machines";

const members = schema.tachoMachineGroupMembers;
const hosts = schema.tachoHosts;

/** One machine in one group, as the list reads it. */
export interface MachineGroupMachine {
  machineId: string;
  hostname: string;
  /** tacho.hosts.status as stored. The list handler parses it to the enum. */
  status: string;
  addedAt: Date;
}

export interface MachineGroup {
  group: string;
  machines: MachineGroupMachine[];
}

export interface AddMachineInput {
  group: string;
  machineId: string;
  /** The user who made the change, recorded as the row's creator. */
  addedByUserId: string | null;
}

export interface AddMachineResult {
  /** When the machine joined the group. */
  addedAt: Date;
  /** False when the machine was already in the group. */
  added: boolean;
}

export interface RemoveMachineInput {
  group: string;
  machineId: string;
}

export interface MachineGroupStore {
  addMachineToGroup(
    scope: MachineScope,
    input: AddMachineInput,
  ): Promise<AddMachineResult>;
  /** True when a membership was deleted. */
  removeMachineFromGroup(
    scope: MachineScope,
    input: RemoveMachineInput,
  ): Promise<boolean>;
  listMachineGroups(
    scope: MachineScope,
    filter: { group?: string },
  ): Promise<MachineGroup[]>;
}

const inWorkspace = (
  table: typeof members | typeof hosts,
  scope: MachineScope,
) =>
  and(eq(table.orgId, scope.orgId), eq(table.workspaceId, scope.workspaceId));

/** The machine's host row in this workspace, in any status, or null. */
async function findHost(tx: Tx, scope: MachineScope, machineId: string) {
  const [host] = await tx
    .select({ id: hosts.id, status: hosts.status })
    .from(hosts)
    .where(and(inWorkspace(hosts, scope), eq(hosts.publicId, machineId)))
    .limit(1);
  return host ?? null;
}

/** The store over one tenant transaction, so a handler audits in the same one. */
export function postgresMachineGroupStore(tx: Tx): MachineGroupStore {
  return {
    async addMachineToGroup(scope, input) {
      const host = await findHost(tx, scope, input.machineId);
      if (!host) {
        throw new HandlerError({
          code: "not_found",
          reason: "machine_not_found",
          message: `No machine ${input.machineId} is enrolled in this workspace. Enroll the machine, then add it to the group.`,
        });
      }
      if (host.status === "revoked") {
        throw new HandlerError({
          code: "conflict",
          reason: "machine_revoked",
          message: `Machine ${input.machineId} is revoked, so it cannot join a group. Enroll it again, then add it.`,
        });
      }
      const [inserted] = await tx
        .insert(members)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          groupName: input.group,
          hostId: host.id,
          createdById: input.addedByUserId,
        })
        .onConflictDoNothing({
          target: [members.workspaceId, members.groupName, members.hostId],
        })
        .returning({ createdAt: members.createdAt });
      if (inserted) return { addedAt: inserted.createdAt, added: true };

      // The machine was already in the group. Answer with the row it has.
      const [existing] = await tx
        .select({ createdAt: members.createdAt })
        .from(members)
        .where(
          and(
            inWorkspace(members, scope),
            eq(members.groupName, input.group),
            eq(members.hostId, host.id),
          ),
        )
        .limit(1);
      if (!existing) {
        // The insert conflicted on a row this transaction cannot read. Only a
        // concurrent removal between the two statements does that.
        throw new HandlerError({
          code: "conflict",
          reason: "membership_changed",
          message: `Machine ${input.machineId} left group ${input.group} while it was being added. Add it again.`,
        });
      }
      return { addedAt: existing.createdAt, added: false };
    },

    async removeMachineFromGroup(scope, input) {
      // Any status, so a revoked machine can still leave a group.
      const host = await findHost(tx, scope, input.machineId);
      if (!host) return false;
      const deleted = await tx
        .delete(members)
        .where(
          and(
            inWorkspace(members, scope),
            eq(members.groupName, input.group),
            eq(members.hostId, host.id),
          ),
        )
        .returning({ id: members.id });
      return deleted.length > 0;
    },

    async listMachineGroups(scope, filter) {
      const rows = await tx
        .select({
          group: members.groupName,
          machineId: hosts.publicId,
          hostname: hosts.hostname,
          status: hosts.status,
          addedAt: members.createdAt,
        })
        .from(members)
        .innerJoin(hosts, eq(hosts.id, members.hostId))
        .where(
          and(
            inWorkspace(members, scope),
            filter.group === undefined
              ? undefined
              : eq(members.groupName, filter.group),
          ),
        )
        .orderBy(asc(members.groupName), asc(hosts.publicId));
      const groups: MachineGroup[] = [];
      for (const { group, ...machine } of rows) {
        const last = groups.at(-1);
        if (last?.group === group) last.machines.push(machine);
        else groups.push({ group, machines: [machine] });
      }
      return groups;
    },
  };
}

/**
 * The groups a machine is in, for the cloud gateway's check before it signs
 * an envelope. A revoked machine is in no group, and so is a machine this
 * workspace never enrolled.
 */
export const postgresMachineGroupReader: MachineGroupReader = {
  groupsOf: (scope, machine) =>
    runInTenantScope(scope, () =>
      withTenantDb(async (tx) => {
        const rows = await tx
          .selectDistinct({ group: members.groupName })
          .from(members)
          .innerJoin(hosts, eq(hosts.id, members.hostId))
          .where(
            and(
              inWorkspace(members, scope),
              eq(hosts.publicId, machine),
              ne(hosts.status, "revoked"),
            ),
          )
          .orderBy(asc(members.groupName));
        return rows.map((row) => row.group);
      }),
    ),
};
