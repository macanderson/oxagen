// authority.ts: a record that tries to grant authority. A record steers what
// an agent does. Only Cedar policy grants or denies, and it never allows.
import type { TreeCheck } from "../finding";
import { finder } from "../finding";
import { recordFieldLine, recordFiles } from "../repo";
import type { Finding } from "../types";

const find = finder("authority");

export const authorityCheck: TreeCheck = (tree) => {
  const findings: Finding[] = [];
  for (const file of recordFiles(tree)) {
    const { effect, kind } = file.raw;
    if (effect === undefined || effect === null) continue;
    const text = tree.get(file.path) as string;
    const line = recordFieldLine(file, text, "effect");
    if (effect === "allow") {
      findings.push(
        find({
          rule: "no-allow",
          path: file.path,
          line,
          field: "effect",
          message: "A record cannot allow anything. Only a person or a Cedar policy grants authority.",
          expected: "effect: require or effect: forbid.",
          fix: "Remove effect: allow. To permit a tool call, write a Cedar policy under policy/, which a reviewer approves.",
        }),
      );
      continue;
    }
    if (kind !== "constraint") {
      findings.push(
        find({
          rule: "effect-on-constraint-only",
          path: file.path,
          line,
          field: "effect",
          message: `Only a constraint takes an effect, and this record is a ${typeof kind === "string" ? kind : "record with no kind"}.`,
          expected: "effect only on a record of kind constraint.",
          fix: "Remove effect, or set kind: constraint.",
        }),
      );
    }
  }
  return findings;
};
