/**
 * `list_machine_groups`: the workspace's machine groups and the machines in
 * each (mcp-studio-spec, Local servers, Machines).
 *
 * A group appears while one machine is in it. A revoked machine stays listed
 * with its status, because its membership row stays until someone removes
 * it, but the cloud gateway never sends it a call. Groups come sorted by
 * name, and machines within a group by enrollment id.
 *
 * The workspace is the caller's scope, so the input names none. It may name
 * one group to read only that group.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  hostEnrollmentIdSchema,
  machineGroupNameSchema,
  tachoHostStatusSchema,
} from "../tacho/schemas";

export const tachoMachineGroupList = registerCapability({
  name: "list_machine_groups",
  domain: "tacho",
  description:
    "List the workspace's machine groups and the machines in each, with each machine's hostname and enrollment status.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "unit", "docs"],
  scoped: true,
  mutates: false,
  noBillingGate: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      /** Read only this group. Absent reads every group. */
      group: machineGroupNameSchema.optional(),
    })
    .strict(),
  output: z
    .object({
      groups: z.array(
        z
          .object({
            group: machineGroupNameSchema,
            machines: z.array(
              z
                .object({
                  machineId: hostEnrollmentIdSchema,
                  hostname: z.string(),
                  status: tachoHostStatusSchema,
                  addedAt: z.string().datetime(),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
});

export type TachoMachineGroupListInput = z.output<
  typeof tachoMachineGroupList.input
>;
export type TachoMachineGroupListOutput = z.output<
  typeof tachoMachineGroupList.output
>;
