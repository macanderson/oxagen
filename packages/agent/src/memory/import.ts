import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import {
  memoryKindEnum,
  memoryWeightEnum,
} from "@oxagen/oxagen/contracts/agent.memory.import.shared";
import type { CapabilityContext } from "../types";
import { MEMORY_KIND_GUIDE, MEMORY_WEIGHT_GUIDE } from "./taxonomy";

/**
 * import.ts — document → draft-memory extraction for bulk memory import.
 *
 * Where embed.ts/neo4j.ts handle persistence, this module is the read-only
 * "understand the document" half: it asks the AI gateway to break one markdown
 * document (a skill file, rule set, runbook) into atomic, self-contained
 * memories and classify each by kind + weight. agent.memory.import.parse calls
 * this once per uploaded document; nothing here writes to the graph.
 */

type MemoryKind = z.infer<typeof memoryKindEnum>;
type MemoryWeight = z.infer<typeof memoryWeightEnum>;

export interface ExtractedMemory {
  lesson: string;
  kind: MemoryKind;
  weight: MemoryWeight;
}

// The model returns a flat list of atomic memories for a single document. Cap at
// 50 per document so one huge file can't blow up a parse response; the system
// prompt also asks the model to merge near-duplicates.
const extractionSchema = z.object({
  memories: z
    .array(
      z.object({
        lesson: z.string().min(1).max(2000),
        kind: memoryKindEnum,
        weight: memoryWeightEnum,
      }),
    )
    .max(50),
});

const EXTRACTION_SYSTEM = [
  "You convert an engineering knowledge document (a skill file, coding rule set, runbook, or playbook) into a set of atomic, self-contained agent memories.",
  "",
  "Rules:",
  "- Extract each distinct rule, constraint, convention, gotcha, or durable fact as its OWN memory. Split compound guidance into separate memories.",
  "- Each lesson must stand alone WITHOUT the document: rewrite it as one or two imperative, present-tense sentences an agent can act on. Never reference 'this document', 'above', or 'the section'.",
  "- Skip pure narrative prose, headings, tables of contents, and examples that carry no durable rule. Merge near-duplicate statements.",
  "- Classify every memory with a kind and a weight:",
  "",
  MEMORY_KIND_GUIDE,
  "",
  MEMORY_WEIGHT_GUIDE,
  "",
  "Return the structured object only. If the document contains no durable rules, return an empty array.",
].join("\n");

/**
 * Extract and classify atomic memories from one document. Errors (no gateway
 * key, model failure) propagate — the parse handler catches per-document and
 * records the file as skipped, so one bad document never fails the batch.
 */
export async function extractMemoriesFromDocument(args: {
  content: string;
  filename: string;
  ctx: CapabilityContext;
}): Promise<ExtractedMemory[]> {
  const { object } = await generateObjectFor({
    schema: extractionSchema,
    system: EXTRACTION_SYSTEM,
    // Lead with the filename so the model can use it as a topical hint, then the
    // raw content. generateObjectFor meters this call to ClickHouse.
    prompt: `Filename: ${args.filename}\n\n${args.content}`,
    telemetry: {
      orgId: args.ctx.orgId,
      workspaceId: args.ctx.workspaceId,
      surface: args.ctx.surface,
      messageId: args.ctx.messageId,
    },
  });
  return object.memories;
}

/**
 * Map over `items` running at most `limit` calls of `fn` concurrently, returning
 * results in input order. Bounds the fan-out of per-document extraction and
 * per-draft embedding so a large import doesn't open hundreds of simultaneous
 * gateway requests. Shared by both import handlers.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
