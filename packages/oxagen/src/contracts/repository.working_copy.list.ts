/**
 * `list_working_copies`: every directory the CLI reported for this workspace
 * (MC spec §10.1, the Working copies tab), most recently seen first.
 *
 * The rows are what `record_working_copy` received, so they describe each
 * directory as of its `lastSeenAt` and no later. A console read outside the
 * metering surface: `noBillingGate: true`, `mutates: false`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  commitShaSchema,
  workingCopyEventSchema,
  workingCopyIdSchema,
  workingCopySymlinksSchema,
} from "./repository.working_copy.shared";

const instant = z.string().datetime({ offset: true });

export const workingCopyRowSchema = z
  .object({
    id: workingCopyIdSchema,
    hostname: z.string(),
    directory: z.string(),
    repository: z.string().nullable(),
    branch: z.string().nullable(),
    headCommit: commitShaSchema.nullable(),
    oxagenPresent: z.boolean(),
    symlinks: workingCopySymlinksSchema,
    pulledCommit: commitShaSchema.nullable(),
    lastEvent: workingCopyEventSchema,
    /** The person whose session sent the latest report; null for a key. */
    reportedBy: z
      .object({ userId: z.string(), name: z.string().nullable() })
      .strict()
      .nullable(),
    cliVersion: z.string().nullable(),
    firstSeenAt: instant,
    lastSeenAt: instant,
  })
  .strict();
export type WorkingCopyRow = z.infer<typeof workingCopyRowSchema>;

export const workingCopyList = registerCapability({
  name: "list_working_copies",
  domain: "repository",
  description:
    "List the directories the CLI linked to this workspace, with machine, path, repository, branch, head, the state of .oxagen/, the commit last pulled and when each was last seen.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
    },
  },
  input: z
    .object({
      limit: z.number().int().min(1).max(200).default(100),
    })
    .strict(),
  output: z
    .object({
      workingCopies: z.array(workingCopyRowSchema),
    })
    .strict(),
});

export type WorkingCopyListInput = z.output<typeof workingCopyList.input>;
export type WorkingCopyListOutput = z.output<typeof workingCopyList.output>;
