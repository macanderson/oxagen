// source.ts: what makes a source change material.
//
// A work item's material revision moves when its subject, description, or
// labels change (tasks-spec.md §8.5). A comment, an assignee, or a status
// change does not move it. The collector pipeline raises an "updated" change on
// the same three fields (packages/ingestion/src/collectors/pipeline.ts), and
// its changeDigest also hashes the provider's update time, so it differs on
// every update. The digest here leaves the time out: the same text always has
// the same digest, and a touch that changes nothing material moves nothing.
import { digestJcs, type Sha256Digest } from "@oxagen/run-evidence";

/** The fields of a source item that decide its material revision. */
export interface SourceMaterial {
  subject: string;
  description: string | null;
  labels: readonly string[];
}

/** The digest of a source item's material fields. Labels are compared as a set. Pure. */
export function sourceDigest(material: SourceMaterial): Sha256Digest {
  const labels = [...new Set(material.labels)].sort();
  return digestJcs({ subject: material.subject, description: material.description, labels });
}
