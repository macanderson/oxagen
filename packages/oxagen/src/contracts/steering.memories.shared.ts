// steering.memories.shared.ts: the shapes the workspace memory contracts
// share (memory-collection spec, Memories tab, Promotion, and Capabilities;
// ADR-245). Not a capability: the barrel exports it so the file-coverage
// guard sees it.
//
// A workspace memory is a row of agent.memories: what an agent wrote in its
// harness's own memory store, or through remember_lesson and
// record_reflection. It steers only the agent that wrote it, through that
// harness. It reaches other agents only once a person promotes it into a
// steering record and the memory PR merges. Oxagen embeds no memory.
import { z } from "zod";
import { repoRefSchema } from "../steering-repo/common";
import { recordEffectSchema } from "../steering-repo/record-effect";
import { recordKindSchema } from "../steering-repo/record-kind";
import { tachoHarnessSchema } from "../tacho/schemas";
import { recordForceSchema } from "./context.steering.shared";

/** A memory's public id. */
export const workspaceMemoryIdSchema = z
  .string()
  .regex(/^mem_[0-9A-Za-z]+$/, "a memory id is mem_ followed by letters and digits");

/** Where a memory is in its life (ADR-245). */
export const workspaceMemoryStateSchema = z.enum([
  "waiting",
  "in_pr",
  "promoted",
  "dismissed",
  "retired",
]);
export type WorkspaceMemoryState = z.output<typeof workspaceMemoryStateSchema>;

/** How a memory reached Oxagen (memory/v1 `capture`). */
export const workspaceMemoryCaptureSchema = z.enum([
  "remember",
  "pull_request",
  "local_gateway",
  "import",
]);

/** A Claude Code memory file's `metadata.type`, such as `feedback`. */
export const workspaceMemoryTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/);

/** The memory PR that last cited a memory. */
export const workspaceMemoryPrRefSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string(),
    status: z.enum(["open", "merged", "closed"]),
  })
  .strict();

/** One memory as the Memories tab lists it. */
export const workspaceMemorySchema = z
  .object({
    id: workspaceMemoryIdSchema,
    /** The memory file's frontmatter `name`, when it has one. */
    label: z.string().nullable(),
    /** The memory file's frontmatter `description`, when it has one. */
    summary: z.string().nullable(),
    statement: z.string(),
    state: workspaceMemoryStateSchema,
    capture: workspaceMemoryCaptureSchema,
    /** The harness whose memory store holds the memory, or null for a memory no harness holds. */
    harness: tachoHarnessSchema.nullable(),
    /** The agent that wrote it, by lineage, or null when Oxagen could not tell. */
    agent: z.string().nullable(),
    /** `<harness>:<path>` for a harness memory file, a PR URL, or null. */
    source: z.string().nullable(),
    repos: z.array(z.string()).nullable(),
    memory_type: z.string().nullable(),
    kind: recordKindSchema,
    /** Distinct runs that used it, plus the uses a harness counted with no run. */
    use_count: z.number().int().nonnegative(),
    /**
     * False when the harness reports no use of its memories, so a zero
     * count reads as "No signal" and not as unused.
     */
    use_signal: z.boolean(),
    last_used_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
    /** The steering record that carries it, once promoted. */
    promoted_lineage: z.string().nullable(),
    memory_pr: workspaceMemoryPrRefSchema.nullable(),
  })
  .strict();
export type WorkspaceMemory = z.output<typeof workspaceMemorySchema>;

/**
 * Memories that say the same thing: the same statement hash, or 80% of
 * their content words in common with neither one negating alone. The
 * highest ranked memory speaks for the group.
 */
export const workspaceMemoryGroupSchema = z
  .object({
    /** The highest ranked memory of the group. */
    memory: workspaceMemorySchema,
    /** Every memory in the group, the first one included, in ranking order. */
    members: z.array(workspaceMemorySchema).min(1),
    /** The members' uses added together. */
    use_count: z.number().int().nonnegative(),
    /** The newest use of any member. */
    last_used_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type WorkspaceMemoryGroup = z.output<typeof workspaceMemoryGroupSchema>;

/** A steering record kind a person can promote a memory as. A skill is a folder, so it is not one. */
export const promotableKindSchema = recordKindSchema.exclude(["skill"]);
export type PromotableKind = z.output<typeof promotableKindSchema>;

/** One draft steering record a person promotes, with the memories it cites. */
export const memoryDraftRecordSchema = z
  .object({
    memory_ids: z
      .array(workspaceMemoryIdSchema)
      .min(1)
      .max(50)
      .describe("The memories the record cites. The first one's statement is the default body."),
    statement: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe("The record's body. Defaults to the first memory's statement."),
    kind: promotableKindSchema
      .optional()
      .describe("Defaults to the first memory's kind."),
    force: recordForceSchema
      .optional()
      .describe(
        "Must be a force the kind allows: any for a rule kind, may or info for a preference, info for a fact or a memory. Defaults to should, may, or info.",
      ),
    effect: recordEffectSchema
      .optional()
      .describe(
        "Required when the record is a constraint, and refused for any other kind.",
      ),
    repos: z
      .array(repoRefSchema)
      .min(1)
      .max(20)
      .optional()
      .describe(
        "The code repositories the record is scoped to. Defaults to the first memory's. Without any, the record is workspace-wide.",
      ),
  })
  .strict()
  .superRefine((draft, ctx) => {
    // A draft that names no kind takes its first memory's, so the handler
    // checks the effect against that kind.
    if (draft.kind === "constraint" && draft.effect === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effect"],
        message: "a constraint names its effect, require or forbid",
      });
    if (
      draft.kind !== undefined &&
      draft.kind !== "constraint" &&
      draft.effect !== undefined
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effect"],
        message: "only a constraint has an effect",
      });
  });
export type MemoryDraftRecord = z.output<typeof memoryDraftRecordSchema>;
