// `add_group_machine`: put one enrolled machine in one machine group
// (mcp-studio-spec, Local servers, Machines).
//
// A server.toml whose `source.machines` names a group runs only on the
// machines in that group. The cloud gateway reads the membership this handler
// writes before it signs a call for a machine.
//
// The handler admits the org roles the contract grants, before it reads any
// tenant data. It writes the membership and one
// `tacho.machine_group_changed` security event in one transaction. A machine
// already in the group is left as it is, and the event still records the
// decision with `changed: false`.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  type TachoMachineGroupAddOutput,
  tachoMachineGroupAdd,
} from "@oxagen/oxagen/contracts/tacho.machine_group.add";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { withTenantDb } from "@oxagen/database";
import { emitSecurityEventIn } from "@oxagen/database/security";
import { contractRoleRequirement } from "../../lib/capability-role-guard";
import { type MachineGroupStore, postgresMachineGroupStore } from "./groups-store";

/** The audit row this handler writes, in the shape the security events table takes. */
export type AuditEvent = Parameters<typeof emitSecurityEventIn>[1];

/** Writes one audit row inside the same transaction as the membership. */
export type AuditSink = (event: AuditEvent) => Promise<void>;

export type MachineGroupWriteDeps = {
  /** Run `fn` against a store and an audit sink inside one tenant transaction. */
  withStore<T>(
    fn: (store: MachineGroupStore, audit: AuditSink) => Promise<T>,
  ): Promise<T>;
  now: () => Date;
};

/** A store and audit sink over one tenant transaction. */
export function defaultMachineGroupWriteDeps(): MachineGroupWriteDeps {
  return {
    withStore: (fn) =>
      withTenantDb((tx) =>
        fn(postgresMachineGroupStore(tx), (event) =>
          emitSecurityEventIn(tx, event),
        ),
      ),
    now: () => new Date(),
  };
}

export function createTachoMachineGroupAddHandler(
  deps: MachineGroupWriteDeps,
): CapabilityHandler<typeof tachoMachineGroupAdd> {
  return async (input, ctx): Promise<TachoMachineGroupAddOutput> => {
    // The acting user is the signed-in user or the creator of the API key.
    // That user is recorded as the membership's creator and the event's actor.
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      contractRoleRequirement(tachoMachineGroupAdd),
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    return deps.withStore(async (store, audit) => {
      const result = await store.addMachineToGroup(scope, {
        group: input.group,
        machineId: input.machineId,
        addedByUserId: actingUserId,
      });
      await audit({
        eventType: "tacho.machine_group_changed",
        actorUserId: actingUserId,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        capability: tachoMachineGroupAdd.name,
        outcome: "success",
        occurredAt: deps.now(),
        ip: ctx.clientIp ?? null,
        userAgent: null,
        requestId: ctx.requestId,
        detail: {
          change: "added",
          group: input.group,
          machineId: input.machineId,
          changed: result.added,
        },
      });
      return {
        group: input.group,
        machineId: input.machineId,
        addedAt: result.addedAt.toISOString(),
        added: result.added,
      };
    });
  };
}

export const tachoMachineGroupAddHandler = createTachoMachineGroupAddHandler(
  defaultMachineGroupWriteDeps(),
);
