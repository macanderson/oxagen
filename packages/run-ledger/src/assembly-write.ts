/**
 * Writing a frame's reassembly beside its wire, at ingest (spec §14).
 *
 * This is the whole of stage two: a model stream is folded ONCE, where the
 * frame is written, and the result is stored next to the recorded bytes. No
 * reader folds a stream again, and the list a run page reads never carries
 * the wire at all.
 *
 * The recorded bytes are untouched. The assembly is derived — the hash chain
 * covers the body and nothing here — so every way this can go wrong is a
 * reported outcome and never a failed append: a frame whose assembly did not
 * land still records exactly what it recorded before, and the reader folds
 * that frame's wire itself the first time somebody opens it.
 */
import {
  assembleModelStream,
  encodeAssembly,
  looksLikeModelStream,
} from "./content-blocks";
import type { RunBodyStore } from "./frame-body";

/**
 * What happened to one frame's assembly. Every value is a fact the caller can
 * log or count; none of them is an exception, because none of them is a
 * reason to refuse the frame.
 */
export type AssemblyWrite =
  | "stored"
  /** The store has no assembly seam: the deployment keeps wire only. */
  | "no_store"
  /** The bytes are not a recorded model stream (a prompt, a tool argument). */
  | "not_a_stream"
  /** The bytes are not UTF-8, so there is no stream to fold. */
  | "not_text"
  /** The write itself failed. The frame is recorded; the fold is not stored. */
  | "failed";

const decoder = new TextDecoder("utf-8", { fatal: true });

export interface AssemblyWriteInput {
  orgId: string;
  workspaceId: string;
  runId: string;
  /** The reference the body landed on; the assembly is keyed from it. */
  bodyRef: string;
  bytes: Uint8Array;
}

/**
 * Fold one recorded model stream and store the result beside its wire.
 *
 * What is stored is derived from the BYTES and nothing else. The object's key
 * is the body's own digest (`evidenceAssemblyKey`), so two calls in one
 * workspace whose retained response bytes are identical share one object by
 * construction — a title prompt asked twice, a cached reply, a short refusal.
 * Anything call-specific written into that object is therefore overwritten by
 * whichever call folded last, and reopening the earlier run would report the
 * later call's figures.
 *
 * The call's own clock is the case in point. Time to first token and wall time
 * belong to one call, not to the bytes, so they are not stored here at all;
 * the frame row carries them (`tacho_events.ttft_ms`, `api_duration_ms`) and
 * the read overlays them on each frame's own assembly (`readAssembly` in
 * @oxagen/handlers). Keeping the object content-derived is what makes sharing
 * it safe.
 */
export async function writeAssembly(
  store: Pick<RunBodyStore, "putAssembly">,
  input: AssemblyWriteInput,
): Promise<AssemblyWrite> {
  const putAssembly = store.putAssembly;
  if (putAssembly === undefined) return "no_store";
  let wire: string;
  try {
    wire = decoder.decode(input.bytes);
  } catch {
    return "not_text";
  }
  if (!looksLikeModelStream(wire)) return "not_a_stream";
  const assembly = assembleModelStream(wire);
  if (assembly === null) return "not_a_stream";
  try {
    await putAssembly.call(store, {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      runId: input.runId,
      bodyRef: input.bodyRef,
      bytes: encodeAssembly(assembly),
    });
    return "stored";
  } catch {
    return "failed";
  }
}
