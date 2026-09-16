#!/usr/bin/env node
/**
 * De-registered is not deleted, and this guard is what makes that a fact rather
 * than an intention.
 *
 * `DEREGISTERED.md` records every feature taken off Oxagen's surfaces whose code
 * stays in the tree — the marketplace and the plugin catalog, fourteen of the
 * seventeen ingestion connectors, environments, prompt settings, and the reads
 * Appendix E folded into their objects. The spec that de-registered them
 * (`docs/specs/mission-control/spec.md`, App. E) says "dropped", and a session
 * reading that word literally would `git rm` several thousand lines that the
 * product is expected to grow back into.
 *
 * So the ledger carries a `preserved-paths` block, and this script asserts every
 * path in it still exists. Deleting one fails the build with the row that
 * claimed it. The only sanctioned way past this guard is to write the ADR, move
 * the row to DEREGISTERED.md §13, and take the path out of the block — which is
 * a diff a reviewer can see, rather than a silent prune.
 *
 * Deliberately an existence check and nothing more. Whether the code still
 * compiles is `typecheck`'s job and whether it still passes is the test suite's;
 * what neither of them notices is a file that stopped being there on purpose.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The fenced ```preserved-paths block, one repo-relative path per line. */
export function preservedPaths(markdown) {
  const block = markdown.match(/^```preserved-paths\n([\s\S]*?)^```/m);
  if (!block) return null;
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function missingPaths(paths, exists) {
  return paths.filter((path) => !exists(path));
}

function main() {
  const ledger = join(repoRoot, "DEREGISTERED.md");
  if (!existsSync(ledger)) {
    console.error(
      "check:deregistered — DEREGISTERED.md is missing from the repo root.\n" +
        "It is the register of features taken off the surfaces whose code stays " +
        "in the tree. Deleting it deletes the only record of why that code is " +
        "unreachable, which is how the code gets pruned next.",
    );
    process.exit(1);
  }

  const paths = preservedPaths(readFileSync(ledger, "utf8"));
  if (paths === null) {
    console.error(
      "check:deregistered — DEREGISTERED.md has no ```preserved-paths block.\n" +
        "§14 carries it, and this guard reads nothing else.",
    );
    process.exit(1);
  }
  if (paths.length === 0) {
    console.error(
      "check:deregistered — the preserved-paths block is empty.\n" +
        "An empty block passes vacuously, which is worse than no guard at all. " +
        "If every row really has been deleted under an ADR, delete the guard too.",
    );
    process.exit(1);
  }

  const missing = missingPaths(paths, (path) =>
    existsSync(join(repoRoot, path)),
  );
  if (missing.length > 0) {
    console.error(
      `check:deregistered — ${missing.length} preserved path(s) no longer exist:\n` +
        missing.map((path) => `  ${path}`).join("\n") +
        "\n\nDE-REGISTERED IS NOT DELETED. These belong to features Oxagen took " +
        "off its surfaces on purpose and kept in the tree on purpose " +
        "(DEREGISTERED.md §1).\n" +
        "If the deletion was deliberate: write the ADR, move the row to " +
        "DEREGISTERED.md §13, and remove the path from the §14 block in the same " +
        "PR.\nIf it was not: restore the files.",
    );
    process.exit(1);
  }

  console.log(
    `check:deregistered — ${paths.length} preserved paths present. De-registered, not deleted.`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("check-deregistered.mjs")) {
  main();
}
