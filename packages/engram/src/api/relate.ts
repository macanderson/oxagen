/**
 * engram.relate() — write an entity relationship (edge).
 *
 * Creates a directed edge between two entities in the memory graph.
 * Both the entities and the edge are stored as records so they participate
 * in content addressing and retrieval.
 */
import { createRecord } from "../record";
import { computeSalience } from "../salience";
import { validateNamespace } from "../namespace";
import type { EdgeBody, MemoryRecord, WriteOpts } from "../types";
import type { EpisodicStore } from "../store/episodic";

/**
 * Create a relationship between two entities.
 *
 * @param source Source entity record ID.
 * @param edgeType Relationship type (from ontology EdgeTypes).
 * @param target Target entity record ID.
 * @param properties Optional edge properties.
 * @returns The content-addressed ID of the edge record.
 */
export async function relate(
  store: EpisodicStore,
  source: string,
  edgeType: string,
  target: string,
  opts: WriteOpts,
  properties?: Record<string, unknown>,
): Promise<string> {
  const namespace = validateNamespace(opts.namespace);

  const body: EdgeBody = {
    sourceId: source,
    targetId: target,
    edgeType,
    properties,
  };

  const salience = opts.salience ?? computeSalience("edge", body);

  const record: MemoryRecord = createRecord({
    kind: "edge",
    namespace,
    body,
    salience,
    confidence: 1.0,
    provenance: opts.provenance,
    causality: opts.causality,
  });

  await store.append(record);
  return record.id;
}
