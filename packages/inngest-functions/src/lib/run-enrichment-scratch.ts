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
//
// The read step returns the sha256 of each chunk it kept, and Inngest keeps
// that output in the step's record. A later read checks the chunk against
// the digest it is handed from that record. A scratch envelope names no
// path, and every job's scratch is sealed under the same KEK, so any scratch
// object at a chunk's key would decrypt. The digest does not come from the
// manifest, which is a scratch object at a key anyone who can write scratch
// can predict. A chunk whose bytes do not match, or one with no digest to
// check, is a failed read that no retry can pass.
import { NonRetriableError } from "@oxagen/functions";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { digestBytes } from "@oxagen/tacho";
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

// A manifest written before the digests moved to the read step's output
// also names them. The schema drops them, since no read trusts them.
const manifestSchema = z.object({
  /** How many chunk names the job may have written, over every attempt. */
  chunks: z.number().int().min(0),
});
type Manifest = z.infer<typeof manifestSchema>;
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
 * The job's manifest: null when it wrote none, and "unreadable" when its
 * bytes do not parse as one. A storage failure other than a missing object
 * is thrown.
 */
async function readManifest(
  scope: RunScope,
  jobRunId: string,
): Promise<Manifest | "unreadable" | null> {
  let bytes: Uint8Array;
  try {
    ({ bytes } = await evidenceStore().getScratch(
      scope,
      jobRunId,
      ENRICHMENT_SCRATCH_MANIFEST,
    ));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  try {
    return manifestSchema.parse(JSON.parse(decoder.decode(bytes)));
  } catch {
    return "unreadable";
  }
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
  const manifest = await readManifest(scope, jobRunId);
  if (manifest === null) return 0;
  return manifest === "unreadable" ? ENRICHMENT_MAX_CHUNKS : manifest.chunks;
}

/** What `keepEnrichmentChunks` kept, for the read step's output. */
export interface KeptEnrichmentChunks {
  /** How many chunk names the job's manifest now holds, over every attempt. */
  scratch: number;
  /**
   * The `digestBytes` of each chunk this attempt kept, by index. The read
   * step returns them, so each later read checks its chunk against the
   * step's record rather than against anything in the bucket.
   */
  digests: string[];
}

/**
 * Keep a job's transcript chunks for its later steps, and answer how many
 * chunks its manifest now names and the digest of each chunk kept. The
 * manifest is written first, so a job that fails part way still names every
 * chunk it wrote. It is written again on every attempt that keeps chunks,
 * because a retry can keep more names than the attempt before it.
 */
export async function keepEnrichmentChunks(
  scope: RunScope,
  jobRunId: string,
  chunks: readonly string[],
): Promise<KeptEnrichmentChunks> {
  const store = evidenceStore();
  const prior = await enrichmentScratchCount(scope, jobRunId);
  const named = Math.max(prior, chunks.length);
  if (chunks.length === 0) return { scratch: named, digests: [] };
  const bodies = chunks.map((text) => encoder.encode(text));
  const manifest: Manifest = { chunks: named };
  await store.putScratch({
    scope,
    jobRunId,
    name: ENRICHMENT_SCRATCH_MANIFEST,
    contentType: "application/json",
    bytes: encoder.encode(JSON.stringify(manifest)),
  });
  for (const [index, bytes] of bodies.entries()) {
    await store.putScratch({
      scope,
      jobRunId,
      name: enrichmentChunkName(index),
      contentType: "text/plain",
      bytes,
    });
  }
  return {
    scratch: named,
    digests: bodies.map((bytes) => digestBytes(bytes)),
  };
}

/**
 * One chunk a job kept, as text, once its bytes match `digest`, the digest
 * the read step returned for it. A chunk that is gone throws a storage
 * error, which the step retries. A chunk with no digest (a read step
 * recorded before the step returned them), or whose bytes do not match,
 * throws `NonRetriableError`: the same read fails the same way on every
 * retry. The job then fails, and its failure handler deletes its chunks.
 */
export async function readEnrichmentChunk(
  scope: RunScope,
  jobRunId: string,
  index: number,
  digest: string | undefined,
): Promise<string> {
  if (digest === undefined)
    throw new NonRetriableError(
      `Enrichment chunk ${String(index)} of job ${jobRunId} has no digest in its read step's output to check it against`,
    );
  const { bytes } = await evidenceStore().getScratch(
    scope,
    jobRunId,
    enrichmentChunkName(index),
  );
  if (digestBytes(bytes) !== digest)
    throw new NonRetriableError(
      `Enrichment chunk ${String(index)} of job ${jobRunId} does not match the digest its read step recorded`,
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
