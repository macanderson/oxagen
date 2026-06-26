/**
 * engram.remember() — write an episodic event.
 *
 * This is the primary write path for agent activity. Every tool call,
 * observation, decision, and reflection becomes an episodic record.
 */
import { createRecord } from "../record";
import { computeSalience } from "../salience";
import { validateNamespace } from "../namespace";
import type { EpisodicBody, MemoryRecord, WriteOpts } from "../types";
import type { EpisodicStore } from "../store/episodic";

/**
 * Write an episodic event to the memory store.
 *
 * @returns The content-addressed ID of the written record.
 */
export async function remember(
  store: EpisodicStore,
  event: EpisodicBody,
  opts: WriteOpts,
): Promise<string> {
  const namespace = validateNamespace(opts.namespace);
  const salience = opts.salience ?? computeSalience("episodic", event);

  const record: MemoryRecord = createRecord({
    kind: "episodic",
    namespace,
    body: event,
    salience,
    confidence: 1.0, // Episodic events are always factual (they happened)
    provenance: opts.provenance,
    causality: opts.causality,
  });

  await store.append(record);
  return record.id;
}
