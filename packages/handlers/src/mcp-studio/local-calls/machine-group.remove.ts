// `remove_group_machine`: take one machine out of one machine group
// (mcp-studio-spec, Local servers, Machines).
//
// After the removal, the cloud gateway stops sending that machine calls for a
// server whose `source.machines` names the group. A revoked machine can still
// be removed, so its old memberships can be cleared.
//
// The handler admits the org roles the contract grants, before it reads any
// tenant data. It deletes the membership and writes one
// `tacho.machine_group_changed` security event in one transaction. Removing a
// membership that does not exist changes nothing, and the event still
// records the decision with `changed: false`.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  type TachoMachineGroupRemoveOutput,
  tachoMachineGroupRemove,
} from "@oxagen/oxagen/contracts/tacho.machine_group.remove";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { contractRoleRequirement } from "../../lib/capability-role-guard";
import {
  defaultMachineGroupWriteDeps,
  type MachineGroupWriteDeps,
} from "./machine-group.add";

export function createTachoMachineGroupRemoveHandler(
  deps: MachineGroupWriteDeps,
): CapabilityHandler<typeof tachoMachineGroupRemove> {
  return async (input, ctx): Promise<TachoMachineGroupRemoveOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      contractRoleRequirement(tachoMachineGroupRemove),
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    return deps.withStore(async (store, audit) => {
      const removed = await store.removeMachineFromGroup(scope, {
        group: input.group,
        machineId: input.machineId,
      });
      await audit({
        eventType: "tacho.machine_group_changed",
        actorUserId: actingUserId,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        capability: tachoMachineGroupRemove.name,
        outcome: "success",
        occurredAt: deps.now(),
        ip: ctx.clientIp ?? null,
        userAgent: null,
        requestId: ctx.requestId,
        detail: {
          change: "removed",
          group: input.group,
          machineId: input.machineId,
          changed: removed,
        },
      });
      return { group: input.group, machineId: input.machineId, removed };
    });
  };
}

export const tachoMachineGroupRemoveHandler =
  createTachoMachineGroupRemoveHandler(defaultMachineGroupWriteDeps());
