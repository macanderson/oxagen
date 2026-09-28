// memory.ts: `memory/v1`, one lesson an agent keeps from a run, as Oxagen
// stores it (steering-repo-spec, Memory and reflection, Memory author).
//
// A memory stays in Oxagen. The curator reads memories and proposes records
// in a memory PR, copying each cited memory's agent, run, statement, and
// evidence into the record's `provenance.memories`. Oxagen purges the cited
// memories when the PR merges or closes.
//
// Oxagen sets `agent` and `run` from the authenticated run, never from tool
// input. The spec pairs them with `capture`: `remember` sets both, a
// `local_gateway` memory has the agent enrollment recorded and a null run,
// and a `pull_request` memory has both or neither. Oxagen applies those
// pairings where it writes a memory. This schema accepts null in either
// field and leaves the pairing to the writer.
import { z } from "zod";
import {
  instantSchema,
  lineageSchema,
  repoRefSchema,
  runIdSchema,
  toolTargetSchema,
} from "./common";
import { recordKindSchema } from "./record-kind";

/** How a memory reached Oxagen. */
export const MEMORY_CAPTURES = [
  "remember",
  "pull_request",
  "local_gateway",
] as const;
export const memoryCaptureSchema = z.enum(MEMORY_CAPTURES);
export type MemoryCapture = z.output<typeof memoryCaptureSchema>;

/** `mem_<id>`, as Oxagen assigns it. */
export const memoryIdSchema = z.string().regex(/^mem_[0-9A-Za-z]+$/);

export const memorySchema = z
  .object({
    schema: z.literal("memory/v1"),
    id: memoryIdSchema,
    agent: lineageSchema
      .nullable()
      .describe(
        "The agent that wrote the memory, as agents/<name>.toml names it. Null when Oxagen cannot tell.",
      ),
    run: runIdSchema
      .nullable()
      .describe(
        "The run the memory came from. Null for a memory the local gateway read, or one found in a pull request whose run Oxagen did not record.",
      ),
    capture: memoryCaptureSchema.describe(
      "remember during a run, pull_request from the code repository check, or local_gateway from a harness's memory folder.",
    ),
    statement: z.string().min(1).max(2000),
    kind: recordKindSchema.describe(
      "What the memory would be as a record. Most are memory.",
    ),
    repos: z.array(repoRefSchema).min(1).optional(),
    applies_to: z.array(z.string().min(1)).min(1).optional(),
    tools: z.array(toolTargetSchema).min(1).optional(),
    evidence: z
      .array(z.string().min(1))
      .describe(
        "What backs the memory, such as frame:run_<id>/<n>. A memory with a null run cites no frame.",
      ),
    created_at: instantSchema,
  })
  .strict();
export type Memory = z.output<typeof memorySchema>;
