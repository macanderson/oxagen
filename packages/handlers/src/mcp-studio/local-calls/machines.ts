// machines.ts: which machines may run a local server (mcp-studio-spec, Local
// servers, Machines).
//
// An admin puts enrolled machines into named groups. A machine runs a local
// server, or a registry package with source.machines, only when one of its
// groups is in the server's source.machines. The cloud gateway checks this
// before it signs an envelope, so a machine outside the group never receives
// a call. A suspended machine runs nothing, whatever its groups (#4554).
import { machineSuspended, notInGroup, type LocalServerRefusal } from "@oxagen/recorder/local-servers";

/** The workspace a machine is enrolled in. */
export interface MachineScope {
  orgId: string;
  workspaceId: string;
}

/** Reads a machine's groups. `groups-store.ts` reads them from Postgres. */
export interface MachineGroupReader {
  /**
   * The groups the machine runs local servers for, in this workspace. Empty
   * when the machine is in none, is not enrolled, is revoked, or is
   * suspended, so every caller that claims or dispatches work for it gets
   * none.
   */
  groupsOf(scope: MachineScope, machine: string): Promise<readonly string[]>;
  /**
   * True when this workspace enrolled the machine and it is suspended.
   * checkMachine asks only after a group check fails, so the refusal names the
   * suspension rather than a group change.
   */
  isSuspended(scope: MachineScope, machine: string): Promise<boolean>;
}

/**
 * Who enrolled each machine. A Studio draft's listing starts a program before
 * any review, so it runs only on a machine the person who asked enrolled
 * (ADR-233). `groups-store.ts` reads it from tacho.hosts.
 */
export interface MachineOwnerReader {
  /**
   * The user who enrolled `machine` in this workspace, or null when it is not
   * enrolled, is revoked, or no person enrolled it.
   */
  ownerOf(scope: MachineScope, machine: string): Promise<string | null>;
  /** True when `userId` enrolled a machine, not revoked, in one of `groups`. */
  ownsMachineIn(scope: MachineScope, userId: string, groups: readonly string[]): Promise<boolean>;
}

/**
 * The refusal for a machine none of whose groups the server names, or
 * undefined when the machine may run it. A server that names no groups runs
 * nowhere.
 */
export function machineGroupRefusal(
  serverGroups: readonly string[],
  machineGroups: readonly string[],
): LocalServerRefusal | undefined {
  const member = new Set(machineGroups);
  return serverGroups.some((group) => member.has(group)) ? undefined : notInGroup(serverGroups);
}

/**
 * Read the machine's groups and check them against the server's
 * source.machines. A suspended machine is in no group, and it is refused with
 * machine_suspended so the person lifts the suspension instead of changing a
 * group.
 */
export async function checkMachine(
  reader: MachineGroupReader,
  scope: MachineScope,
  machine: string,
  serverGroups: readonly string[],
): Promise<LocalServerRefusal | undefined> {
  if (serverGroups.length === 0) return notInGroup(serverGroups);
  const refusal = machineGroupRefusal(serverGroups, await reader.groupsOf(scope, machine));
  if (refusal === undefined) return undefined;
  return (await reader.isSuspended(scope, machine)) ? machineSuspended() : refusal;
}
