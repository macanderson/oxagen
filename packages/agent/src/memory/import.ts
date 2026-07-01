import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import {
  memoryClassEnum,
  memoryKindSchema,
} from "@oxagen/oxagen/contracts/agent.memory.model";
import type { CapabilityContext } from "../types";
import { MEMORY_CLASS_GUIDE, MEMORY_KIND_GUIDE } from "./taxonomy";

/**
 * import.ts — document → draft-memory extraction for bulk memory import.
 *
 * Where embed.ts/neo4j.ts handle persistence, this module is the read-only
 * "understand the document" half: it asks the AI gateway to break one markdown
 * document (a skill file, rule set, runbook) into atomic, self-contained
 * memories and classify each by the two-axis class + kind. agent.memory.import.parse
 * calls this once per uploaded document; nothing here writes to the graph.
 */

// The classifier only ever proposes OBSERVATION or RULE — FACT is reachable
// solely through agent.memory.promote (requires human confirmation).
const draftClassEnum = memoryClassEnum.exclude(["FACT"]);
type DraftClass = z.infer<typeof draftClassEnum>;

export interface ExtractedMemory {
  lesson: string;
  memoryClass: DraftClass;
  memoryKind: string;
  /** Set (1-100) only when memoryClass is RULE. */
  enforcementScore?: number;
}

// The model returns a flat list of atomic memories for a single document. Cap at
// 50 per document so one huge file can't blow up a parse response; the system
// prompt also asks the model to merge near-duplicates.
const extractionSchema = z.object({
  memories: z
    .array(
      z.object({
        lesson: z.string().min(1).max(2000),
        memoryClass: draftClassEnum,
        memoryKind: memoryKindSchema,
        enforcementScore: z.number().int().min(1).max(100).optional(),
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
  "- Classify every memory with a class and a kind. When class is RULE, also set enforcementScore (1-100) for how strongly it should be followed:",
  "",
  MEMORY_CLASS_GUIDE,
  "",
  MEMORY_KIND_GUIDE,
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
