// `list_machine_groups`: the workspace's machine groups and the machines in
// each (mcp-studio-spec, Local servers, Machines).
//
// The handler admits the roles the contract grants, before it reads any
// tenant data. A revoked machine stays listed with its status until someone
// removes it, so the list shows what still needs clearing.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoHostStatusSchema } from "@oxagen/oxagen/tacho/schemas";
import {
  type TachoMachineGroupListOutput,
  tachoMachineGroupList,
} from "@oxagen/oxagen/contracts/tacho.machine_group.list";
import { withTenantDb } from "@oxagen/database";
import { assertContractRole } from "../../lib/capability-role-guard";
import { type MachineGroupStore, postgresMachineGroupStore } from "./groups-store";

export type MachineGroupReadDeps = {
  /** Run `fn` against a store inside one tenant transaction. */
  withStore<T>(fn: (store: MachineGroupStore) => Promise<T>): Promise<T>;
};

export function createTachoMachineGroupListHandler(
  deps: MachineGroupReadDeps,
): CapabilityHandler<typeof tachoMachineGroupList> {
  return async (input, ctx): Promise<TachoMachineGroupListOutput> => {
    await assertContractRole(tachoMachineGroupList, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const groups = await deps.withStore((store) =>
      store.listMachineGroups(scope, { group: input.group }),
    );
    return {
      groups: groups.map(({ group, machines }) => ({
        group,
        machines: machines.map((machine) => ({
          machineId: machine.machineId,
          hostname: machine.hostname,
          status: tachoHostStatusSchema.parse(machine.status),
          addedAt: machine.addedAt.toISOString(),
        })),
      })),
    };
  };
}

export const tachoMachineGroupListHandler = createTachoMachineGroupListHandler({
  withStore: (fn) => withTenantDb((tx) => fn(postgresMachineGroupStore(tx))),
});
