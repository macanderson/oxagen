// An in-memory MachineGroupStore for the machine group handler tests. It keeps
// the Postgres store's rules: an unknown machine is refused as not found, a
// revoked one as a conflict, a second add answers the first add's time, and
// removing an absent membership changes nothing. It records the scope of
// every call, so a test can check the handler passed the caller's.
// machine-group.pg.test.ts proves the same rules against Postgres.
import { HandlerError } from "@oxagen/oxagen";
import type {
  MachineGroup,
  MachineGroupStore,
} from "../mcp-studio/local-calls/groups-store";
import type { MachineScope } from "../mcp-studio/local-calls/machines";

export type FakeHost = { hostname: string; status: string };

export type FakeMembership = {
  group: string;
  machineId: string;
  addedAt: Date;
  addedByUserId: string | null;
};

export function memoryMachineGroupStore(
  hosts: Record<string, FakeHost>,
  now: () => Date,
) {
  const memberships: FakeMembership[] = [];
  const scopes: MachineScope[] = [];
  const indexOf = (group: string, machineId: string) =>
    memberships.findIndex(
      (m) => m.group === group && m.machineId === machineId,
    );

  const store: MachineGroupStore = {
    async addMachineToGroup(scope, input) {
      scopes.push(scope);
      const host = hosts[input.machineId];
      if (!host)
        throw new HandlerError({ code: "not_found", reason: "machine_not_found" });
      if (host.status === "revoked")
        throw new HandlerError({ code: "conflict", reason: "machine_revoked" });
      const existing = memberships[indexOf(input.group, input.machineId)];
      if (existing) return { addedAt: existing.addedAt, added: false };
      const addedAt = now();
      memberships.push({
        group: input.group,
        machineId: input.machineId,
        addedAt,
        addedByUserId: input.addedByUserId,
      });
      return { addedAt, added: true };
    },

    async removeMachineFromGroup(scope, input) {
      scopes.push(scope);
      const at = indexOf(input.group, input.machineId);
      if (at < 0) return false;
      memberships.splice(at, 1);
      return true;
    },

    async listMachineGroups(scope, filter) {
      scopes.push(scope);
      const rows = memberships
        .filter((m) => filter.group === undefined || m.group === filter.group)
        .sort(
          (a, b) =>
            a.group.localeCompare(b.group) ||
            a.machineId.localeCompare(b.machineId),
        );
      const groups: MachineGroup[] = [];
      for (const m of rows) {
        const host = hosts[m.machineId];
        const machine = {
          machineId: m.machineId,
          hostname: host?.hostname ?? "",
          status: host?.status ?? "active",
          addedAt: m.addedAt,
        };
        const last = groups.at(-1);
        if (last?.group === m.group) last.machines.push(machine);
        else groups.push({ group: m.group, machines: [machine] });
      }
      return groups;
    },
  };

  return { store, memberships, scopes };
}
