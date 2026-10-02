/**
 * One memory a harness wrote on an enrolled host, sent by the Tacho daemon
 * (ADR-206, "Outside a run"). The daemon's memory reader watches the folders
 * where each harness keeps its own memories and sends each new or changed
 * file here. The memory waits for the curator like any other, with capture
 * `local_gateway`, the host's agent as its agent, and no run. A file keeps
 * one waiting memory, and each new statement replaces its text (ADR-238).
 * A Claude Code memory file's frontmatter `name`, `description`, and
 * `metadata.type` arrive as `label`, `summary`, and `memory_type` (ADR-248).
 *
 * Machine-to-machine, authenticated by the host's API key. The host names
 * itself so the handler can check the key's scope names the same host.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { hostEnrollmentIdSchema, tachoHarnessSchema } from "../tacho/schemas";
import { lessonInputSchema } from "./agent.memory.lesson.remember";

export const tachoMemoriesIngest = registerCapability({
  name: "ingest_tacho_memories",
  domain: "tacho",
  description:
    "Store one memory a harness wrote on an enrolled Tacho host, for the curator to review.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      host_enrollment_id: hostEnrollmentIdSchema,
      /** The harness whose memory folder holds the file. */
      harness: tachoHarnessSchema,
      /** The file's path on the host. With the harness, it is the memory's source. */
      path: z.string().min(1).max(1024),
      // The lesson's bounds, with this field's own description: the published
      // JSON Schema otherwise calls a harness's memory file a lesson.
      statement: lessonInputSchema.shape.statement.describe(
        "The memory file's body without its frontmatter, trimmed.",
      ),
      /** The file's frontmatter `name`. */
      label: z.string().trim().min(1).max(200).optional(),
      /** The file's frontmatter `description`. */
      summary: z.string().trim().min(1).max(1000).optional(),
      /** The file's frontmatter `metadata.type`, such as `feedback`. */
      memory_type: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{0,31}$/)
        .optional(),
    })
    .strict(),
  output: z
    .object({
      /**
       * False when the workspace already holds this statement from this
       * file. True when it stored a new waiting memory or replaced the text
       * of the file's waiting memory (ADR-238).
       */
      stored: z.boolean(),
    })
    .strict(),
});

export type TachoMemoriesIngestInput = z.output<
  typeof tachoMemoriesIngest.input
>;
export type TachoMemoriesIngestOutput = z.output<
  typeof tachoMemoriesIngest.output
>;
