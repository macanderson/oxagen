/**
 * engram.assert() — write a semantic fact.
 *
 * Semantic facts are distilled knowledge with a confidence score.
 * They can supersede prior facts (the supersedes chain forms a correction log).
 */
import { createRecord } from "../record";
import { computeSalience } from "../salience";
import { validateNamespace } from "../namespace";
import type { MemoryRecord, SemanticBody, WriteOpts } from "../types";
import type { EpisodicStore } from "../store/episodic";

/**
 * Assert a semantic fact into the memory store.
 *
 * @param confidence 0.0–1.0 — how certain this fact is.
 * @returns The content-addressed ID of the written record.
 */
export async function assert(
  store: EpisodicStore,
  fact: SemanticBody,
  confidence: number,
  opts: WriteOpts,
): Promise<string> {
  const namespace = validateNamespace(opts.namespace);
  const salience = opts.salience ?? computeSalience("semantic", fact);

  const record: MemoryRecord = createRecord({
    kind: "semantic",
    namespace,
    body: fact,
    salience,
    confidence: Math.min(1, Math.max(0, confidence)),
    provenance: opts.provenance,
    causality: opts.causality,
  });

  await store.append(record);
  return record.id;
}
