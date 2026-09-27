// machines.ts: which machines may run a local server (mcp-studio-spec, Local
// servers, Machines).
//
// An admin puts enrolled machines into named groups. A machine runs a local
// server, or a registry package with source.machines, only when one of its
// groups is in the server's source.machines. The cloud gateway checks this
// before it signs an envelope, so a machine outside the group never receives
// a call.
import { notInGroup, type LocalServerRefusal } from "@oxagen/tacho/local-servers";

/** The workspace a machine is enrolled in. */
export interface MachineScope {
  orgId: string;
  workspaceId: string;
}

/** Reads a machine's groups. `groups-store.ts` reads them from Postgres. */
export interface MachineGroupReader {
  /** The groups the machine is in, in this workspace. Empty when the machine is in none or is not enrolled. */
  groupsOf(scope: MachineScope, machine: string): Promise<readonly string[]>;
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

/** Read the machine's groups and check them against the server's source.machines. */
export async function checkMachine(
  reader: MachineGroupReader,
  scope: MachineScope,
  machine: string,
  serverGroups: readonly string[],
): Promise<LocalServerRefusal | undefined> {
  if (serverGroups.length === 0) return notInGroup(serverGroups);
  return machineGroupRefusal(serverGroups, await reader.groupsOf(scope, machine));
}
