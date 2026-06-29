import type { CapabilityContext } from "../types";
import {
  extractMemoriesFromDocument,
  mapWithConcurrency,
  type ExtractedMemory,
} from "../memory/import";
import type {
  AgentMemoryImportParseInput,
  AgentMemoryImportParseOutput,
} from "@oxagen/oxagen/contracts/agent.memory.import.parse";
import type { MemoryImportDraft } from "@oxagen/oxagen/contracts/agent.memory.import.shared";

export type { AgentMemoryImportParseInput, AgentMemoryImportParseOutput };

/** Free-form notes with no code anchor group under this synthetic ref. */
const USER_MEMORY_NODE_REF = "user-memory";

// One extraction call per document; cap concurrency so a 25-document batch
// doesn't open 25 simultaneous gateway requests.
const DOC_CONCURRENCY = 4;

/**
 * agent.memory.import.parse — extract editable draft memories from uploaded
 * documents. Read-only: runs classification via the AI gateway and returns
 * drafts; it never touches the graph (commit does). A document that yields no
 * memories or errors during extraction is reported in `skipped` rather than
 * failing the whole batch.
 */
export async function agentMemoryImportParseHandler(
  input: AgentMemoryImportParseInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryImportParseOutput> {
  const defaultNodeRef = input.defaultNodeRef?.trim() || USER_MEMORY_NODE_REF;

  const perDocument = await mapWithConcurrency(
    input.documents,
    DOC_CONCURRENCY,
    async (doc) => {
      try {
        const extracted = await extractMemoriesFromDocument({
          content: doc.content,
          filename: doc.filename,
          ctx,
        });
        return { filename: doc.filename, extracted };
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Extraction failed";
        return { filename: doc.filename, error: reason };
      }
    },
  );

  const drafts: MemoryImportDraft[] = [];
  const skipped: { filename: string; reason: string }[] = [];
  let documentCount = 0;

  for (const result of perDocument) {
    if ("error" in result) {
      skipped.push({ filename: result.filename, reason: result.error });
      continue;
    }
    if (result.extracted.length === 0) {
      skipped.push({
        filename: result.filename,
        reason: "No durable rules found in this document.",
      });
      continue;
    }
    documentCount += 1;
    for (const memory of result.extracted) {
      drafts.push({
        lesson: memory.lesson,
        kind: memory.kind,
        weight: memory.weight,
        // Imported documents are human-curated knowledge → source "user".
        source: "user",
        nodeRef: defaultNodeRef,
        sourceDocument: result.filename,
        // Every draft's kind/weight came from the model here.
        classified: true,
      });
    }
  }

  return { drafts, documentCount, skipped };
}
