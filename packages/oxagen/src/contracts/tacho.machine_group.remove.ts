/**
 * `remove_group_machine`: take a machine out of a machine group
 * (mcp-studio-spec, Local servers, Machines).
 *
 * Once the machine is out, the cloud gateway stops signing envelopes for it
 * for the local servers that name only this group. Removing the last machine
 * removes the group. Removing a machine that is not in the group changes
 * nothing and answers `removed: false`. A revoked machine can still be
 * removed. Each change writes one `tacho.machine_group_changed` security
 * event.
 *
 * The workspace is the caller's scope, so the input names none. Managing a
 * group spends no governed action units (`noBillingGate: true`).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  hostEnrollmentIdSchema,
  machineGroupNameSchema,
} from "../tacho/schemas";

export const tachoMachineGroupRemove = registerCapability({
  name: "remove_group_machine",
  domain: "tacho",
  description:
    "Take a machine out of a machine group, so it stops running the local servers that name only that group.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "unit", "docs"],
  scoped: true,
  mutates: true,
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      group: machineGroupNameSchema,
      /** The machine's enrollment id (`tch_…`). */
      machineId: hostEnrollmentIdSchema,
    })
    .strict(),
  output: z
    .object({
      group: machineGroupNameSchema,
      machineId: hostEnrollmentIdSchema,
      /** False when the machine was not in the group. */
      removed: z.boolean(),
    })
    .strict(),
});

export type TachoMachineGroupRemoveInput = z.output<
  typeof tachoMachineGroupRemove.input
>;
export type TachoMachineGroupRemoveOutput = z.output<
  typeof tachoMachineGroupRemove.output
>;
