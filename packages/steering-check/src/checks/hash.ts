// hash.ts: a stamped id or hash that does not match the record's content.
import { stampRecord } from "@oxagen/oxagen/steering-repo";
import type { TreeCheck } from "../finding";
import { finder } from "../finding";
import { recordFieldLine, recordFiles } from "../repo";
import type { Finding } from "../types";

const find = finder("hash");

export const hashCheck: TreeCheck = (tree, env) => {
  const known = new Set<string>();
  if (env.base) {
    for (const file of recordFiles(env.base)) if (file.lineage) known.add(file.lineage);
  }
  for (const record of env.index?.records ?? []) known.add(record.lineage);
  const findings: Finding[] = [];
  for (const file of recordFiles(tree)) {
    if (file.record === null || file.lineage === null) continue;
    const { id, hash } = file.raw;
    if (id === undefined && hash === undefined) continue;
    const stamp = stampRecord(file.raw, file.body);
    if (stamp.id === id && stamp.hash === hash) continue;
    const published = known.has(file.lineage);
    const field = published ? "hash" : "id";
    findings.push(
      find({
        rule: "stale-stamp",
        path: file.path,
        line: recordFieldLine(file, tree.get(file.path) as string, field) ?? recordFieldLine(file, tree.get(file.path) as string, "id"),
        field,
        message: published
          ? "The record changed, but its id and hash still name the published version."
          : "The record carries an id and hash that Oxagen did not write for this content.",
        expected: `id ${stamp.id} and hash ${stamp.hash}, or no id and hash before the merge.`,
        fix: "Delete the id and hash lines. Oxagen writes them when the steering PR merges.",
      }),
    );
  }
  return findings;
};
