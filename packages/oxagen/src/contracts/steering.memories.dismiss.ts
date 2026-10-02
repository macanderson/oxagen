/**
 * dismiss_memories: a person sets memories aside, or brings them back
 * (memory-collection spec, Lifecycle; ADR-248).
 *
 * A dismissed memory leaves the Memories tab's default view, and its
 * statement hash joins `memory_rejections`, so the curator does not propose
 * the statement again without new evidence. A waiting memory and one an
 * open memory PR cites can be dismissed. The PR keeps its record, and the
 * memory stays dismissed when the PR settles.
 *
 * With `restore: true`, a dismissed memory waits again, and its statement
 * hash leaves `memory_rejections` once no other dismissed memory holds the
 * same statement. A memory in any other state, and one this workspace does
 * not hold, comes back in `skipped`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  workspaceMemoryIdSchema,
  workspaceMemoryStateSchema,
} from "./steering.memories.shared";

/** The most memories one call dismisses or restores. */
export const DISMISS_MEMORIES_MAX = 200;

export const steeringMemoriesDismiss = registerCapability({
  name: "dismiss_memories",
  domain: "context",
  description:
    "Dismiss workspace memories so the curator does not propose their statements again, or restore dismissed memories with restore: true.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs"],
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
      memory_ids: z
        .array(workspaceMemoryIdSchema)
        .min(1)
        .max(DISMISS_MEMORIES_MAX),
      restore: z
        .boolean()
        .default(false)
        .describe("Bring dismissed memories back to waiting instead."),
    })
    .strict(),
  output: z
    .object({
      /** The memories this call dismissed, or restored with `restore: true`. */
      changed: z.array(workspaceMemoryIdSchema),
      /** The memories left as they were, and why. */
      skipped: z.array(
        z
          .object({
            memory_id: workspaceMemoryIdSchema,
            /** The memory's state, or null when this workspace holds no such memory. */
            state: workspaceMemoryStateSchema.nullable(),
          })
          .strict(),
      ),
      /** Statement hashes this call added to, or removed from, `memory_rejections`. */
      rejections: z.number().int().nonnegative(),
    })
    .strict(),
});

export type SteeringMemoriesDismissInput = z.output<
  typeof steeringMemoriesDismiss.input
>;
export type SteeringMemoriesDismissOutput = z.output<
  typeof steeringMemoriesDismiss.output
>;
