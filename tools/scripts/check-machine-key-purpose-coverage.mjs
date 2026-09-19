#!/usr/bin/env node
/**
 * `packages/iam/src/machine-key-scope.ts` must handle every scope `purpose`
 * value a live key can carry, or a purpose it should exempt or allow can
 * silently fall through to the fail-closed "does not recognise" branch and
 * deny a credential everything.
 *
 * ## The regression this guards
 *
 * #3222 added the `purpose === CLI_SESSION_SCOPE_PURPOSE` branch to this
 * file so a CLI session key is exempt from the machine-key mandate. #3178,
 * cut before that merge, squash-merged over it (issue #3237): the branch
 * silently overwrote it with the pre-#3222 file, which had no such branch.
 * Every `cli_session_v1` key was then denied every capability, and
 * `oxagen login` was broken in production for about eight hours.
 *
 * This check does not prevent that class of merge (`check-stale-merge-base`
 * is the advisory for that). It protects the one file structurally: however
 * the branch is lost, whether by a stale merge base, a hand edit, or a
 * refactor, a purpose this codebase knows about but `machine-key-scope.ts`
 * no longer branches on fails the build, not production.
 *
 * ## What "every purpose value" means here
 *
 * A scope `purpose` constant is declared as `export const X_PURPOSE = "...";`
 * somewhere under `packages/`. Several names can mint the same string value
 * (`TACHO_HOST_PURPOSE` here and `TACHO_HOST_SCOPE_PURPOSE` in
 * `packages/handlers/src/lib/tacho-enrollment.ts` both mint `"tacho_host_v1"`),
 * so declarations are grouped by their VALUE, not their name, before asking
 * whether this file handles it.
 *
 * A value is "handled" when at least one of its names appears in this file
 * either compared (`purpose === NAME`) or as a `MACHINE_KEY_CAPABILITIES` key
 * (`[NAME]:`). A value is "blocked" when `resolveApiKey`
 * (`packages/auth/src/resolvers/api-key.ts`) refuses it before this gate is
 * ever reached, the way it refuses `agent_credential_v1` with
 * `purpose_locked` rather than returning `ok: true` (MC spec §6.2: an agent
 * credential is locked to the run-token exchange, which no surface serves
 * yet). Only a value that is neither is reported.
 *
 * Usage: node tools/scripts/check-machine-key-purpose-coverage.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES_DIR = join(repoRoot, "packages");
const MACHINE_KEY_SCOPE_PATH = join(
  repoRoot,
  "packages/iam/src/machine-key-scope.ts",
);
const API_KEY_RESOLVER_PATH = join(
  repoRoot,
  "packages/auth/src/resolvers/api-key.ts",
);

/**
 * Matches `export const X_PURPOSE = "value"`, with or without a trailing
 * `as const`, and across the declaration spanning one or two lines (some
 * declarations wrap the literal onto its own line for width).
 */
const PURPOSE_DECL_RE =
  /export const (\w+_PURPOSE)\s*=[\s\S]{0,80}?"([a-z0-9_]+)"/g;

/** Every `X_PURPOSE = "value"` declaration in a source string. */
export function extractPurposeDeclarations(source) {
  const found = [];
  const re = new RegExp(PURPOSE_DECL_RE.source, "g");
  let m = re.exec(source);
  while (m !== null) {
    found.push({ name: m[1], value: m[2] });
    m = re.exec(source);
  }
  return found;
}

/** Every non-test `.ts` file under `root`, recursively. */
export function collectSourceFiles(root, readDir = readdirSync) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readDir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

/** Every purpose declaration across `files`, tagged with the file it came from. */
export function allPurposeDeclarations(
  files,
  readFile = (f) => readFileSync(f, "utf8"),
) {
  const all = [];
  for (const file of files) {
    for (const decl of extractPurposeDeclarations(readFile(file))) {
      all.push({ ...decl, file });
    }
  }
  return all;
}

/**
 * Whether `name` is branched on, or used as a capability-map key, in
 * `source`. The two shapes this file actually uses: a direct comparison
 * (the CLI session and gateway purposes) and a `MACHINE_KEY_CAPABILITIES`
 * entry (the Tacho host and Stella telemetry purposes).
 */
export function isHandledInSource(source, name) {
  const compared = new RegExp(`purpose\\s*===\\s*${name}\\b`);
  const asKey = new RegExp(`\\[\\s*${name}\\s*\\]\\s*:`);
  return compared.test(source) || asKey.test(source);
}

/**
 * Whether `resolveApiKey` refuses this purpose before `machineKeyDenial` is
 * ever called with it: `if (purpose === NAME) { ... ok: false ... }` within
 * a short window after the comparison.
 */
export function isBlockedBeforeGate(apiKeySource, name) {
  const re = new RegExp(`purpose\\s*===\\s*${name}\\)\\s*\\{([\\s\\S]{0,150})`);
  const m = re.exec(apiKeySource);
  if (!m) return false;
  return /ok:\s*false/.test(m[1]);
}

/**
 * Every purpose VALUE that neither `machine-key-scope.ts` handles under any
 * of its names, nor `resolveApiKey` blocks before the gate under any of
 * them. An empty array is the passing state.
 */
export function missingCoverage({
  declarations,
  machineKeyScopeSource,
  apiKeySource,
}) {
  const byValue = new Map();
  for (const decl of declarations) {
    const names = byValue.get(decl.value) ?? new Set();
    names.add(decl.name);
    byValue.set(decl.value, names);
  }

  const missing = [];
  for (const [value, names] of byValue) {
    const nameList = [...names];
    const handled = nameList.some((name) =>
      isHandledInSource(machineKeyScopeSource, name),
    );
    const blocked = nameList.some((name) =>
      isBlockedBeforeGate(apiKeySource, name),
    );
    if (!handled && !blocked) {
      missing.push({ value, names: nameList });
    }
  }
  return missing.sort((a, b) => a.value.localeCompare(b.value));
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const files = collectSourceFiles(PACKAGES_DIR);
  const declarations = allPurposeDeclarations(files);
  const machineKeyScopeSource = readFileSync(MACHINE_KEY_SCOPE_PATH, "utf8");
  const apiKeySource = readFileSync(API_KEY_RESOLVER_PATH, "utf8");

  const missing = missingCoverage({
    declarations,
    machineKeyScopeSource,
    apiKeySource,
  });

  if (missing.length > 0) {
    console.error(
      "check-machine-key-purpose-coverage: FAIL\n\n" +
        "machine-key-scope.ts does not handle every purpose value a live key\n" +
        "can carry. A purpose this codebase mints but this gate does not branch\n" +
        'on falls through to the fail-closed "does not recognise" denial,\n' +
        "which is safe but silently breaks whatever that purpose was for\n" +
        "(#3237, #3222, #3178: this file lost a purpose branch once already):\n\n" +
        missing
          .map(
            (m) =>
              `  - "${m.value}" (declared as ${m.names.join(" / ")}) is not ` +
              "referenced in packages/iam/src/machine-key-scope.ts",
          )
          .join("\n") +
        "\n\nAdd a branch or a MACHINE_KEY_CAPABILITIES entry for it, or block " +
        "it in resolveApiKey before this gate if it must never reach a machine " +
        "key at all.",
    );
    process.exit(1);
  }

  console.log(
    "check-machine-key-purpose-coverage: machine-key-scope.ts handles every " +
      "purpose value resolveApiKey can pass it.",
  );
}
