#!/usr/bin/env node
/**
 * Every third-party action a workflow runs is pinned to a commit SHA.
 *
 * A tag such as `@v4` is a pointer the action's owner can move. Whoever
 * controls that repository, or steals a token for it, can repoint the tag at
 * new code, and the next run of our workflow executes it with our secrets in
 * the environment. A 40-character commit SHA cannot be moved. The tag it came
 * from stays in a trailing comment so a reader and Dependabot can still see
 * the version (#2978).
 *
 * First-party references are exempt: `actions/*` and `github/*` are GitHub's
 * own, `./` paths are this repository's composite actions, and
 * `macanderson/oxagen/...` is this repository's reusable workflows. A
 * `docker://` image must carry a `@sha256:` digest for the same reason a tag
 * must carry a SHA.
 *
 * This is a line scan, not a YAML parse. A `uses:` key is always a scalar on
 * its own line in a step or a job, so the scan reads every one without a YAML
 * dependency, and it ignores comment lines and the word inside a script body.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FIRST_PARTY_PREFIXES = ["actions/", "github/", "macanderson/oxagen/"];
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const USES_LINE = /^\s*(?:-\s+)?uses:\s*["']?([^"'\s#]+)["']?/;

/** Why a `uses:` reference is unpinned, or null when it is pinned or exempt. */
export function pinProblem(ref) {
  if (ref.startsWith("./")) return null;
  if (ref.startsWith("docker://")) {
    return DIGEST.test(ref) ? null : "docker image has no @sha256: digest";
  }
  if (FIRST_PARTY_PREFIXES.some((prefix) => ref.startsWith(prefix))) {
    return null;
  }
  const at = ref.lastIndexOf("@");
  if (at === -1) return "no version, so it runs the default branch";
  const version = ref.slice(at + 1);
  if (!SHA.test(version)) {
    return `version "${version}" is not a 40-character commit SHA`;
  }
  return null;
}

/** Every unpinned third-party `uses:` in one file's text, with its line. */
export function findUnpinned(text) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    const match = line.match(USES_LINE);
    if (!match) return;
    const problem = pinProblem(match[1]);
    if (problem) found.push({ line: index + 1, ref: match[1], problem });
  });
  return found;
}

function isYaml(name) {
  return name.endsWith(".yml") || name.endsWith(".yaml");
}

/** The workflow files and composite action definitions under `.github/`. */
export function workflowFiles(root) {
  const files = [];
  const workflows = join(root, ".github", "workflows");
  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows)) {
      if (isYaml(name)) files.push(join(workflows, name));
    }
  }
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === "action.yml" || name === "action.yaml")
        files.push(path);
    }
  };
  const actions = join(root, ".github", "actions");
  if (existsSync(actions)) walk(actions);
  return files.sort();
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  const failures = [];
  for (const file of workflowFiles(repoRoot)) {
    for (const hit of findUnpinned(readFileSync(file, "utf8"))) {
      failures.push(
        `  ${relative(repoRoot, file)}:${hit.line}  ${hit.ref}  (${hit.problem})`,
      );
    }
  }
  if (failures.length > 0) {
    console.error(
      "check-action-pins: third-party actions must be pinned to a commit SHA.\n\n" +
        `${failures.join("\n")}\n\n` +
        "Resolve the tag with `git ls-remote https://github.com/<owner>/<repo> " +
        "'refs/tags/<tag>^{}'`\n" +
        "(the peeled line, when there is one, is the commit) and write\n" +
        "`uses: <owner>/<repo>@<sha> # <tag>`. A moving tag lets the action's\n" +
        "owner change the code our workflows run with our secrets (#2978).",
    );
    process.exit(1);
  }
  console.log(
    "check-action-pins: every third-party action is pinned to a SHA.",
  );
}
