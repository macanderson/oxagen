/**
 * promote_memories: a person's draft steering records, from the memories
 * they selected (memory-collection spec, Promotion; ADR-206, ADR-248).
 *
 * Each draft cites its memories in `provenance.memories`. The drafts join the
 * open memory PR on its `memory/<date>` branch as one commit, or, when no
 * memory PR is open, the handler opens one on today's branch through the
 * curator's path. Nothing steers until a person merges the PR. The memories
 * move to `in_pr`, and the curator settles the PR as it settles its own:
 * each record that merges promotes its memories, and each one that does not
 * returns them to waiting and rejects its statements.
 *
 * Only a waiting memory is promoted. A memory in any other state, one this
 * workspace does not hold, and one whose statement an open memory PR already
 * proposes come back in `skipped`, and a draft left with no memory is
 * dropped. With `same_text` on, each draft also cites the waiting memories
 * that say the same thing in the same repository, so the curator does not
 * propose them again.
 *
 * A draft takes its first memory's statement, kind, and repositories unless
 * it names its own. Its force defaults to the kind's: should for a rule kind,
 * may for a preference, and info for a fact or a memory.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { recordEffectSchema } from "../steering-repo/record-effect";
import { recordForceSchema } from "./context.steering.shared";
import {
  memoryDraftRecordSchema,
  promotableKindSchema,
  workspaceMemoryIdSchema,
} from "./steering.memories.shared";

/** The most drafts one call promotes. */
export const PROMOTE_DRAFTS_MAX = 50;

export const steeringMemoriesPromote = registerCapability({
  name: "promote_memories",
  domain: "context",
  description:
    "Promote waiting workspace memories into draft steering records. The drafts join the open memory PR, or open one on today's memory branch. Each record cites its memories, and nothing steers until a person merges the PR.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      drafts: z
        .array(memoryDraftRecordSchema)
        .min(1)
        .max(PROMOTE_DRAFTS_MAX)
        .describe("One draft steering record per entry, each citing its memories."),
      same_text: z
        .boolean()
        .default(true)
        .describe(
          "Also cite the waiting memories that say the same thing as a draft's first memory, in the same repository.",
        ),
    })
    .strict(),
  output: z
    .object({
      /** The memory PR the drafts are on, or null when no draft was left to add. */
      pull_request: z
        .object({
          number: z.number().int().positive(),
          url: z.string(),
          branch: z.string(),
          /** True when this call opened the PR, false when the drafts joined an open one. */
          opened: z.boolean(),
        })
        .strict()
        .nullable(),
      /** The records added to the PR, in the order of the drafts. */
      records: z.array(
        z
          .object({
            path: z.string(),
            lineage: z.string(),
            kind: promotableKindSchema,
            force: recordForceSchema,
            effect: recordEffectSchema.nullable(),
            memory_ids: z.array(workspaceMemoryIdSchema).min(1),
          })
          .strict(),
      ),
      /** The memories no record cites, and why. */
      skipped: z.array(
        z
          .object({
            memory_id: workspaceMemoryIdSchema,
            reason: z.enum(["not_found", "not_waiting", "already_proposed"]),
          })
          .strict(),
      ),
    })
    .strict(),
});

export type SteeringMemoriesPromoteInput = z.output<
  typeof steeringMemoriesPromote.input
>;
export type SteeringMemoriesPromoteOutput = z.output<
  typeof steeringMemoriesPromote.output
>;
