// run-enrichment-scratch.ts: the transcript chunks one run-enrichment job
// writes in its read step and reads back in its later steps (#3784).
//
// The chunks live in the evidence store's scratch namespace, keyed by the
// job's Inngest run id (`evidenceScratchKey`), never under the
// content-addressed `bodies/` prefix that frame bodies share. The job deletes
// them once its account is written, and its failure handler deletes them
// when the job fails for good, so none outlives the job that wrote it.
//
// The job writes a manifest before its first chunk, naming how many chunks
// it may have written. A cleanup that has only the job's run id reads the
// manifest to know what to delete. A read step that runs again after a
// failure keeps the larger of the two counts, so a first attempt that wrote
// more chunks than the second leaves none behind.
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { z } from "zod";
import {
  ENRICHMENT_CHUNK_CHARS,
  ENRICHMENT_TEXT_CEILING_CHARS,
} from "./run-enrichment";
import type { RunScope } from "./run-record";

/**
 * The most transcript chunks one job writes: the text ceiling in chunks, and
 * one more for the note that says where the text stops. A cleanup whose
 * manifest cannot be read deletes this many names.
 */
export const ENRICHMENT_MAX_CHUNKS =
  Math.ceil(ENRICHMENT_TEXT_CEILING_CHARS / ENRICHMENT_CHUNK_CHARS) + 1;

/** The scratch object that names how many chunks a job may have written. */
export const ENRICHMENT_SCRATCH_MANIFEST = "manifest";

/** The scratch object name of a job's transcript chunk at `index`. */
export function enrichmentChunkName(index: number): string {
  return `chunk-${index}`;
}

const manifestSchema = z.object({ chunks: z.number().int().min(0) });
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "StorageNotFoundError"
  );
}

/**
 * How many chunks the job's manifest says it may have written: 0 when it
 * wrote no manifest, and the most a job writes when the manifest is
 * unreadable. A storage failure other than a missing object is thrown, so
 * the step retries rather than forgetting what to delete.
 */
export async function enrichmentScratchCount(
  scope: RunScope,
  jobRunId: string,
): Promise<number> {
  let bytes: Uint8Array;
  try {
    ({ bytes } = await evidenceStore().getScratch(
      scope,
      jobRunId,
      ENRICHMENT_SCRATCH_MANIFEST,
    ));
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
  try {
    return manifestSchema.parse(JSON.parse(decoder.decode(bytes))).chunks;
  } catch {
    return ENRICHMENT_MAX_CHUNKS;
  }
}

/**
 * Keep a job's transcript chunks for its later steps, and answer how many
 * chunks its manifest now names. The manifest is written first, so a job
 * that fails part way still names every chunk it wrote.
 */
export async function keepEnrichmentChunks(
  scope: RunScope,
  jobRunId: string,
  chunks: readonly string[],
): Promise<number> {
  const store = evidenceStore();
  const prior = await enrichmentScratchCount(scope, jobRunId);
  const named = Math.max(prior, chunks.length);
  if (named === 0) return 0;
  if (named !== prior) {
    await store.putScratch({
      scope,
      jobRunId,
      name: ENRICHMENT_SCRATCH_MANIFEST,
      contentType: "application/json",
      bytes: encoder.encode(JSON.stringify({ chunks: named })),
    });
  }
  for (const [index, text] of chunks.entries()) {
    await store.putScratch({
      scope,
      jobRunId,
      name: enrichmentChunkName(index),
      contentType: "text/plain",
      bytes: encoder.encode(text),
    });
  }
  return named;
}

/** One chunk a job kept, as text. Throws when the chunk is gone. */
export async function readEnrichmentChunk(
  scope: RunScope,
  jobRunId: string,
  index: number,
): Promise<string> {
  const { bytes } = await evidenceStore().getScratch(
    scope,
    jobRunId,
    enrichmentChunkName(index),
  );
  return decoder.decode(bytes);
}

/**
 * Delete a job's chunks and then its manifest. `count` is how many chunks
 * the manifest names, when the caller has it from the read step's output.
 * Without it the manifest is read. Deleting a name that holds nothing is a
 * no-op, so a cleanup that runs twice is safe. The manifest goes last, so a
 * cleanup that fails part way can still be finished from it.
 */
export async function discardEnrichmentChunks(
  scope: RunScope,
  jobRunId: string,
  count?: number,
): Promise<void> {
  const named = count ?? (await enrichmentScratchCount(scope, jobRunId));
  if (named === 0) return;
  await evidenceStore().deleteScratch(scope, jobRunId, [
    ...Array.from({ length: named }, (_, index) => enrichmentChunkName(index)),
    ENRICHMENT_SCRATCH_MANIFEST,
  ]);
}
