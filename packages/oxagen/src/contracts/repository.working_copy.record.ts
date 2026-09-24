/**
 * `record_working_copy`: the CLI reports a directory it linked to this
 * workspace (MC spec §10.1, the Working copies tab).
 *
 * `oxagen init` sends it after writing `.oxagen/workspace.json`, and `oxagen
 * pull` sends it after writing the published `.oxagen/` tree, so the tab
 * shows each directory with its repository, branch, head, the commit its
 * steering was last pulled at, and when it was last seen. One row per
 * machine and directory: a second report from the same pair updates the row
 * and moves `lastSeenAt`, it does not add another.
 *
 * `machineId` is a hash the CLI derives on the machine, never a hardware
 * serial. `directory` is the absolute path as the machine names it. The
 * report carries no file contents; a working copy's state is never a run's
 * state, because steering reaches a run from the merged commit.
 *
 * Roles: any workspace member may report a directory they linked. Reporting
 * grants nothing. A settings write outside the metering surface:
 * `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  commitShaSchema,
  workingCopyEventSchema,
  workingCopyIdSchema,
  workingCopySymlinksSchema,
} from "./repository.working_copy.shared";

export const workingCopyRecord = registerCapability({
  name: "record_working_copy",
  domain: "repository",
  description:
    "Record a directory the CLI linked to this workspace: its machine, path, git remote, branch, head, the state of .oxagen/ and the commit its steering was last pulled at.",
  mode: "sync",
  surfaces: ["api", "cli"],
  layers: ["schema", "api", "cli", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** A stable hash the CLI derives on the machine. */
      machineId: z.string().regex(/^[0-9a-f]{16,128}$/),
      hostname: z.string().min(1).max(255),
      /** The directory's absolute path on the machine. */
      directory: z.string().min(1).max(1024),
      /** `owner/name` read from the `origin` remote; null without one. */
      repository: z.string().min(3).max(512).nullable(),
      branch: z.string().min(1).max(255).nullable(),
      headCommit: commitShaSchema.nullable(),
      oxagenPresent: z.boolean(),
      symlinks: workingCopySymlinksSchema,
      /** The published commit the last `oxagen pull` wrote; null before one. */
      pulledCommit: commitShaSchema.nullable(),
      event: workingCopyEventSchema,
      cliVersion: z.string().min(1).max(64).nullable(),
    })
    .strict(),
  output: z
    .object({
      workingCopyId: workingCopyIdSchema,
      firstSeenAt: z.string().datetime({ offset: true }),
      lastSeenAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type WorkingCopyRecordInput = z.output<typeof workingCopyRecord.input>;
export type WorkingCopyRecordOutput = z.output<typeof workingCopyRecord.output>;
