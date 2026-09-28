/**
 * `add_group_machine`: put an enrolled machine in a machine group
 * (mcp-studio-spec, Local servers, Machines).
 *
 * A local server, or a registry package with source.machines, runs only on a
 * machine in a group the server names. The cloud gateway reads the groups
 * before it signs a local call envelope, so this capability decides which
 * machines can run which local servers.
 *
 * A group is not a record of its own. It exists while one machine is in it,
 * so adding the first machine creates it. Adding a machine that is already in
 * the group changes nothing and answers `added: false`. A revoked machine
 * cannot join a group. Each change writes one `tacho.machine_group_changed`
 * security event.
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

export const tachoMachineGroupAdd = registerCapability({
  name: "add_group_machine",
  domain: "tacho",
  description:
    "Put an enrolled machine in a machine group, so it can run the local servers that name the group.",
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
      /** The machine's enrollment id (`tch_…`), which its host file holds. */
      machineId: hostEnrollmentIdSchema,
    })
    .strict(),
  output: z
    .object({
      group: machineGroupNameSchema,
      machineId: hostEnrollmentIdSchema,
      /** When the machine joined the group, which is earlier than now when it was already in it. */
      addedAt: z.string().datetime(),
      /** False when the machine was already in the group. */
      added: z.boolean(),
    })
    .strict(),
});

export type TachoMachineGroupAddInput = z.output<
  typeof tachoMachineGroupAdd.input
>;
export type TachoMachineGroupAddOutput = z.output<
  typeof tachoMachineGroupAdd.output
>;
