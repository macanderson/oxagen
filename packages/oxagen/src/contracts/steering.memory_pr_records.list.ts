/**
 * list_memory_pr_records: the records of one memory PR, for the memory PR
 * review card on the Steering page (memory-collection spec, Capabilities;
 * ADR-206, ADR-248).
 *
 * The PR is named by its number. When the workspace's memory PRs hold that
 * number on more than one repository, the newest one answers. Each
 * record comes with its path, lineage, kind, label, and description, and the
 * memories it cites with the agent and run each came from. While the PR is
 * open, the handler reads its branch: a proposed record whose file is gone
 * from the branch was dropped, and `dropped` names the newest commit on the
 * branch that touched its path, the one that removed it. When the branch
 * cannot be read, and for a settled PR, `branch_read` is false and each
 * record takes its label and description from its first memory.
 *
 * A read. It writes nothing, and the in-app agent never receives it.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { recordKindSchema } from "../steering-repo/record-kind";
import {
  workspaceMemoryIdSchema,
  workspaceMemoryStateSchema,
} from "./steering.memories.shared";

const instant = z.string().datetime({ offset: true });

export const steeringMemoryPrRecordsList = registerCapability({
  name: "list_memory_pr_records",
  domain: "context",
  description:
    "List the records one memory PR proposes or archives, each with the memories it cites, and which proposed records were dropped from the PR's branch.",
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
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      number: z
        .number()
        .int()
        .positive()
        .describe("The memory PR's number in its steering repository."),
    })
    .strict(),
  output: z
    .object({
      pull_request: z
        .object({
          id: z.string(),
          number: z.number().int().positive(),
          url: z.string(),
          repository: z.string(),
          branch: z.string(),
          status: z.enum(["open", "merged", "closed"]),
          opened_at: instant,
          settled_at: instant.nullable(),
        })
        .strict(),
      /** True when the handler read the open PR's branch. False for a settled PR. */
      branch_read: z.boolean(),
      records: z.array(
        z
          .object({
            action: z.enum(["propose", "retire"]),
            path: z.string(),
            lineage: z.string(),
            kind: recordKindSchema,
            /** The record's label, from its file or its first memory. */
            title: z.string(),
            /** The record's description, from its file or its first memory. */
            summary: z.string(),
            /**
             * The memories the record cites, in the order the PR cites them.
             * A retirement cites none. A memory deleted before ADR-248 kept
             * every row is left out.
             */
            memories: z.array(
              z
                .object({
                  id: workspaceMemoryIdSchema,
                  statement: z.string(),
                  agent: z.string().nullable(),
                  run: z.string().nullable(),
                  evidence: z.array(z.string()),
                  state: workspaceMemoryStateSchema,
                })
                .strict(),
            ),
            /** The newest commit on the open PR's branch that touched the dropped record's path, or null. */
            dropped: z.object({ commit_sha: z.string() }).strict().nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
});

export type SteeringMemoryPrRecordsListInput = z.output<
  typeof steeringMemoryPrRecordsList.input
>;
export type SteeringMemoryPrRecordsListOutput = z.output<
  typeof steeringMemoryPrRecordsList.output
>;
