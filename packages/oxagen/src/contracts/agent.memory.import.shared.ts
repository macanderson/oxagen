import { z } from "zod";

/**
 * Shared schema for the bulk memory-import flow (agent.memory.import.parse →
 * agent.memory.import.commit).
 *
 * Declared once here and imported by both contracts so the "draft memory" the
 * parse step proposes is structurally the exact thing the commit step writes —
 * the editable review grid in the app round-trips this shape verbatim. The kind
 * and weight enums mirror the closed taxonomy used by agent.memory.write /
 * agent.memory.remember; they live here (not re-declared inline) so the import
 * surface can never drift from the rest of the memory subsystem.
 */

export const memoryKindEnum = z.enum([
  "routine-change",
  "constraint",
  "bug-root-cause",
  "convention-deviation",
  "gotcha",
]);

export const memoryWeightEnum = z.enum(["low", "high", "critical"]);

/**
 * A single proposed memory extracted from an uploaded document. `parse` returns
 * a fully-populated array of these; the user edits them in the grid; `commit`
 * accepts them back. The provenance/classification fields default so an API or
 * CLI caller can hand-construct a draft from just {lesson, kind, weight}.
 */
export const memoryImportDraftSchema = z.object({
  lesson: z
    .string()
    .min(1)
    .max(2000)
    .describe("The atomic lesson/rule to remember, in one or two sentences"),
  kind: memoryKindEnum.describe("The memory kind the parser classified this as"),
  weight: memoryWeightEnum.describe("The salience bucket the parser classified this as"),
  source: z
    .string()
    .min(1)
    .max(64)
    .default("user")
    .describe("Provenance label; defaults to 'user' for an imported document"),
  nodeRef: z
    .string()
    .min(1)
    .max(256)
    .default("user-memory")
    .describe(
      "Graph node id to anchor the memory on; defaults to the 'user-memory' bucket",
    ),
  sourceDocument: z
    .string()
    .max(256)
    .default("")
    .describe("Filename the draft was extracted from — provenance only, not persisted as a field"),
  classified: z
    .boolean()
    .default(false)
    .describe("true when the model inferred kind/weight rather than them being supplied"),
});

export type MemoryImportDraft = z.output<typeof memoryImportDraftSchema>;
export type MemoryImportDraftInput = z.input<typeof memoryImportDraftSchema>;
