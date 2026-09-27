// lineage.ts: two record files that declare one lineage.
import type { TreeCheck } from "../finding";
import { finder } from "../finding";
import { recordFieldLine, recordFiles, type RecordFile } from "../repo";
import type { Finding } from "../types";

const find = finder("lineage");

export const lineageCheck: TreeCheck = (tree) => {
  const groups = new Map<string, RecordFile[]>();
  for (const file of recordFiles(tree)) {
    if (file.lineage === null) continue;
    groups.set(file.lineage, [...(groups.get(file.lineage) ?? []), file]);
  }
  const findings: Finding[] = [];
  for (const [lineage, files] of groups) {
    if (files.length < 2) continue;
    for (const file of files) {
      const others = files.filter((other) => other !== file).map((other) => other.path);
      findings.push(
        find({
          rule: "unique",
          path: file.path,
          line: recordFieldLine(file, tree.get(file.path) as string, "lineage"),
          field: "lineage",
          message: `The lineage ${lineage} is also declared in ${others.join(", ")}.`,
          expected: "One file for each lineage.",
          fix: "Give each record its own lineage, or delete the copy.",
        }),
      );
    }
  }
  return findings;
};
