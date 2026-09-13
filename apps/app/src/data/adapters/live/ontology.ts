// The live ontology adapter. Batch 3 lane A5 (ontology + repos) wires each method to
// its store with a column-level mapping and a contract test that parses a real
// row through the view-model schema. Until then a method returns the milestone
// and gap it waits on (src/data/backing.ts), never a fabricated value.
import "server-only";
import { notBackedFor } from "@/data/backing";
import type { OntologyReadPort } from "@/data/ports";

export const liveOntology: OntologyReadPort = {
  classes: () => Promise.resolve(notBackedFor("ontology", "classes")),
  sources: () => Promise.resolve(notBackedFor("ontology", "sources")),
  repositories: () => Promise.resolve(notBackedFor("ontology", "repositories")),
  versions: () => Promise.resolve(notBackedFor("ontology", "versions")),
  embeddingIndexes: () =>
    Promise.resolve(notBackedFor("ontology", "embeddingIndexes")),
};
