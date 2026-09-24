#!/usr/bin/env node
/**
 * De-registered is not deleted, and this guard is what makes that a fact rather
 * than an intention.
 *
 * `DEREGISTERED.md` records every feature taken off Oxagen's surfaces whose code
 * stays in the tree — the marketplace and the plugin catalog, fourteen of the
 * seventeen ingestion connectors, environments, prompt settings, and the reads
 * Appendix E folded into their objects. The spec that de-registered them
 * (`oxagen-roadmap:docs/oxagen/specs/mission-control/spec.md`, App. E) says "dropped", and a session
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
 *
 * ## Why the block is not the whole check
 *
 * The block listed the contract for most rows and nothing else, so deleting
 * `packages/handlers/src/plugin.catalog.browse.ts`, its API route or its MCP
 * tool passed a guard whose own preamble promises to preserve them (#3135,
 * discussion_r4031534891). Listing 126 more paths by hand would have the same
 * failure mode one row later, so the sibling artifacts are DERIVED instead:
 * every preserved contract declares its own `layers[]`, which is already the
 * repo's statement of which artifacts exist for a capability and is what
 * `check:manifest` reads. A layer the contract claims must have its file.
 *
 * Directory entries are checked for contents as well as existence, because an
 * empty directory satisfies `existsSync` while carrying none of the code the
 * row was written to keep.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/**
 * Where the artifact for one declared layer of a capability lives.
 *
 * Keyed by the contract file's dotted stem, which is still what every artifact
 * is named after during the ADR-025 file-path realignment. `schema`, `agent`,
 * `unit`, `e2e`, `docs` and `app` are deliberately absent: the first is the
 * contract itself, and the rest are not one predictable file each.
 */
export const LAYER_ARTIFACTS = {
  api: (stem) => `apps/api/src/routes/v1/${stem}.ts`,
  mcp: (stem) => `apps/mcp/src/tools/${stem}.ts`,
  cli: (stem) => `apps/cli/src/commands/${stem}.ts`,
};

/** The `layers[]` a contract declares, as written in its source. */
export function declaredLayers(source) {
  const match = source.match(/layers:\s*\[([^\]]*)\]/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0);
}

/** The capability name a contract registers. */
export function declaredName(source) {
  // Anchored to the registerCapability(...) call: `name` is its field, and a
  // whole-file match takes the first `name:` anywhere, a doc comment included.
  // That misparse broke CI once through check_ui_parity; the same shape would
  // silently mis-key a de-registration row here.
  const declStart = source.search(/registerCapability\s*\(/);
  const decl = declStart === -1 ? source : source.slice(declStart);
  const match = decl.match(/name:\s*["']([^"']+)["']/);
  return match ? match[1] : null;
}

/**
 * Where each artifact kind is searched for when the per-stem file is absent.
 *
 * ADR-025 renamed capabilities without renaming files, and several families are
 * served from one combined file — `connection.ts`, `repo.ts`, `plugin-schema.ts`
 * and the rest that CLAUDE.md lists. `check:manifest` handles this by scanning
 * the directory's contents for the capability name, and this guard asks the same
 * question: is the artifact gone, or is it simply not named after the stem.
 */
export const ARTIFACT_KINDS = [
  {
    layer: "handler",
    dirs: ["packages/handlers/src", "packages/agent/src/handlers"],
  },
  { layer: "api", dirs: ["apps/api/src/routes/v1"] },
  { layer: "mcp", dirs: ["apps/mcp/src/tools"] },
  { layer: "cli", dirs: ["apps/cli/src/commands"] },
];

/** Characters that can terminate a module specifier. */
const SPECIFIER_END = new Set(['"', "'", "`"]);

/**
 * Whether `src` imports the contract module for `stem` — the WHOLE specifier,
 * not a prefix of one.
 *
 * A bare `src.includes("contracts/" + stem)` is an unbounded substring test, and
 * capability stems nest: `contracts/plugin.org.install` is a prefix of
 * `contracts/plugin.org.install_bulk`. So deleting BOTH the API route and the
 * MCP tool for `plugin.org.install` still satisfied the guard, because the
 * `_bulk` sibling's own import kept matching. Reproduced by moving both files
 * aside: the guard exited 0 and reported every artifact present.
 *
 * That is the failure this guard exists to catch, so it is worth naming the
 * shape: the scan validated the FORM of a reference — a file containing a
 * string with the right prefix — and was read as validating the SUBSTANCE, that
 * the artifact is still there.
 *
 * A specifier ends at its closing quote, so requiring one is an exact match. The
 * sibling arm below is `"${name}"`, quoted at both ends and therefore already
 * exact; only this arm was open-ended.
 */
export function referencesContractModule(src, stem) {
  const needle = `contracts/${stem}`;
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
    const next = src[i + needle.length];
    if (next !== undefined && SPECIFIER_END.has(next)) return true;
  }
  return false;
}

/** Every `.ts` file directly under `dir`, or [] when it is not there. */
function filesIn(repoRoot, dir) {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((f) => f.endsWith(".ts"));
}

/**
 * Artifacts a preserved contract promises which are no longer anywhere.
 *
 * The handler is unconditional: a registered capability has one, and `layers[]`
 * has no name for it. The rest come from the layers the contract declares. An
 * artifact counts as present when the per-stem file exists OR when some file in
 * its directory names the capability — the combined-file case above.
 */
export function derivedMissingFor(repoRoot, contractPath, source) {
  const stem = basename(contractPath).replace(/\.ts$/, "");
  const name = declaredName(source);
  const layers = new Set(declaredLayers(source));
  const gone = [];
  for (const { layer, dirs } of ARTIFACT_KINDS) {
    if (layer !== "handler" && !layers.has(layer)) continue;
    const present = dirs.some((dir) => {
      if (existsSync(join(repoRoot, `${dir}/${stem}.ts`))) return true;
      // Some handlers carry a `.handler` suffix on the same stem
      // (`plugin.catalog.sync.handler.ts`), which is a naming choice rather
      // than a different artifact.
      //
      // Two exact spellings rather than an open `startsWith(stem + ".")`. The
      // prefix form is the same shape as the substring bug above: it would
      // accept any longer name that happens to extend this one, so a handler
      // could go missing while an unrelated `<stem>.<something>.ts` kept the
      // check green. Nothing in the tree exploits that today — the only match
      // is the intended one — which is exactly when it is cheap to close.
      if (existsSync(join(repoRoot, `${dir}/${stem}.handler.ts`))) return true;
      // The combined and renamed cases: a file that imports the contract
      // module, names the capability, or lazy-registers it under its own name.
      // A handler is always a file named after its capability's stem, so the
      // reference scan below does not apply to it: another handler mentioning
      // `browse_plugin_catalog` in a capability list is a caller, not the
      // handler, and letting that satisfy the check is how the deleted handler
      // slipped past.
      if (layer === "handler") return false;
      return filesIn(repoRoot, dir).some((f) => {
        // A registry is a pointer and a test is a caller; neither is the
        // artifact. `register.ts` naming a handler it can no longer import, or
        // a test asserting a tool that is gone, is the deletion rather than
        // evidence against it, so the scan reads implementation files only.
        if (f === "register.ts" || f === "index.ts") return false;
        if (f.includes(".test.")) return false;
        const src = readFileSync(join(repoRoot, dir, f), "utf8");
        return (
          referencesContractModule(src, stem) ||
          (name !== null && src.includes(`"${name}"`))
        );
      });
    });
    if (!present) gone.push(`${dirs[0]}/${stem}.ts`);
  }
  return gone;
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

  // Derived siblings, and empty directories. Both are gaps the block itself
  // cannot close: one because nobody lists 126 paths by hand and keeps them
  // right, the other because an empty directory exists.
  const derivedMissing = [];
  const emptyDirs = [];
  for (const path of paths) {
    const abs = join(repoRoot, path);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      if (readdirSync(abs).length === 0) emptyDirs.push(path);
      continue;
    }
    if (!path.startsWith("packages/oxagen/src/contracts/")) continue;
    derivedMissing.push(
      ...derivedMissingFor(repoRoot, path, readFileSync(abs, "utf8")),
    );
  }

  if (emptyDirs.length > 0) {
    console.error(
      `check:deregistered — ${emptyDirs.length} preserved directory/ies are empty:\n` +
        emptyDirs.map((path) => `  ${path}`).join("\n") +
        "\n\nAn empty directory satisfies an existence check and carries none of " +
        "the code the row was written to keep.",
    );
    process.exit(1);
  }

  if (missing.length === 0 && derivedMissing.length > 0) {
    console.error(
      `check:deregistered — ${derivedMissing.length} artifact(s) a preserved contract declares no longer exist:\n` +
        derivedMissing.map((path) => `  ${path}`).join("\n") +
        "\n\nThe contract still names these layers, so the ledger's promise covers " +
        "them even though the block lists only the contract.\nRestore them, or — if " +
        "the removal was deliberate — take the layer off the contract in the same " +
        "PR, which is a diff a reviewer can see.",
    );
    process.exit(1);
  }

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
    `check:deregistered — ${paths.length} preserved paths present, plus every artifact their contracts declare. De-registered, not deleted.`,
  );
}

if (process.argv[1] && process.argv[1].endsWith("check-deregistered.mjs")) {
  main();
}
