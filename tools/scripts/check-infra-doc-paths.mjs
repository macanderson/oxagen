#!/usr/bin/env node
/**
 * Every `infra/...` path a document names must resolve to a real file.
 *
 * The infrastructure used to live in a sibling repository, `oxagen-aws-infra`,
 * and moved into this one under `infra/` — with the pre-move production stack
 * landing at `infra/legacy/` rather than at the path it had before. Documents
 * written against the old layout kept naming `infra/environments/production`
 * and `infra/bootstrap`, which now resolve to nothing: a reader following the
 * pointer finds an empty path and has no way to tell whether the file was
 * renamed, deleted, or never written. That is the failure this guard exists to
 * prevent, and it is the reason the guard is worth its cost — a stale pointer
 * in an operations runbook is read at exactly the moment nobody has time to go
 * looking for where the file actually went.
 *
 * A plan is allowed to name a path that does not exist yet: proposing a module
 * is the whole point of writing the plan. Those live in PROPOSED below, each
 * with the document that proposes it, so the exemption is a claim somebody made
 * on purpose rather than a silent hole in the check. When a proposed module is
 * actually built, its entry here stops matching anything and the guard says so,
 * which is the prompt to delete the entry.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Paths a document proposes building, which therefore do not exist yet.
 * Key: the path. Value: why it is exempt, naming the document that proposes it.
 */
const PROPOSED = new Map([
  [
    "infra/modules/install-funnel/",
    "proposed by docs/ops/stella-website-aws-deploy-plan.md, not built",
  ],
  [
    "infra/modules/kms-signing/",
    "proposed by docs/specs/run-evidence-ingress/03-evidence-ledger-plan.md, not built",
  ],
  [
    "infra/modules/agent-worker/",
    "proposed by docs/specs/run-evidence-ingress/03-evidence-ledger-plan.md, not built",
  ],
]);

/** The archived repository. Naming it as somewhere to go sends a reader nowhere. */
const ARCHIVED_REPO = "oxagen-aws-infra";

/**
 * Files that may still name the archived repository, because they are saying
 * it is archived rather than pointing at it.
 */
const MAY_NAME_ARCHIVED_REPO = new Set([
  "README.md",
  "docs/ops/aws-deployment-plan.md",
  "infra/README.md",
  "tools/scripts/check-infra-doc-paths.mjs",
]);

function trackedFiles() {
  return execFileSync("git", ["ls-files", "*.md", "*.sh", "*.yml", "*.yaml"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
}

/** A proposed prefix covers the files under it, so `foo/` exempts `foo/main.tf`. */
function isProposed(path) {
  for (const prefix of PROPOSED.keys()) {
    if (path === prefix || path.startsWith(prefix)) return true;
  }
  return false;
}

const INFRA_PATH = /`(infra\/[A-Za-z0-9_./-]+)`/g;

const dangling = [];
const staleRepoRefs = [];
const seenProposed = new Set();
let resolved = 0;

for (const file of trackedFiles()) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, file), "utf8");
  } catch {
    continue;
  }

  if (text.includes(ARCHIVED_REPO) && !MAY_NAME_ARCHIVED_REPO.has(file)) {
    for (const [i, line] of text.split("\n").entries()) {
      if (line.includes(ARCHIVED_REPO)) {
        staleRepoRefs.push({ file, line: i + 1, text: line.trim() });
      }
    }
  }

  for (const match of text.matchAll(INFRA_PATH)) {
    // A trailing period is sentence punctuation that landed inside the backticks.
    const path = match[1].replace(/\.$/, "");
    if (isProposed(path)) {
      for (const prefix of PROPOSED.keys()) {
        if (path === prefix || path.startsWith(prefix))
          seenProposed.add(prefix);
      }
      continue;
    }
    if (existsSync(resolve(ROOT, path))) {
      resolved += 1;
    } else {
      const line = text.slice(0, match.index).split("\n").length;
      dangling.push({ file, line, path });
    }
  }
}

/** A proposal that got built should lose its exemption rather than keep it silently. */
const builtButStillExempt = [...PROPOSED.keys()].filter((p) =>
  existsSync(resolve(ROOT, p)),
);

const problems = [];

if (dangling.length > 0) {
  problems.push(
    `${dangling.length} document reference(s) name an infra/ path that does not exist:\n` +
      dangling
        .map(
          (d) =>
            `  ${d.file}:${d.line} -> ${d.path}\n` +
            `      The pre-move production stack is at infra/legacy/; check there first.`,
        )
        .join("\n"),
  );
}

if (staleRepoRefs.length > 0) {
  problems.push(
    `${staleRepoRefs.length} reference(s) point at the archived ${ARCHIVED_REPO} repository.\n` +
      `The infrastructure lives in this repository under infra/, and the OIDC trust\n` +
      `policy on gha-infra-apply names this repository, so the archived one cannot\n` +
      `apply anything. Re-point the reference, or add the file to\n` +
      `MAY_NAME_ARCHIVED_REPO if it is describing the archival rather than pointing at it:\n` +
      staleRepoRefs.map((r) => `  ${r.file}:${r.line}  ${r.text}`).join("\n"),
  );
}

if (builtButStillExempt.length > 0) {
  problems.push(
    `${builtButStillExempt.length} PROPOSED exemption(s) now name a path that exists.\n` +
      `The module was built, so the exemption is stale — delete it from PROPOSED in\n` +
      `tools/scripts/check-infra-doc-paths.mjs:\n` +
      builtButStillExempt.map((p) => `  ${p}`).join("\n"),
  );
}

if (problems.length > 0) {
  console.error(`check-infra-doc-paths: FAIL\n\n${problems.join("\n\n")}\n`);
  process.exit(1);
}

console.log(
  `check-infra-doc-paths: OK — ${resolved} infra/ path reference(s) resolve, ` +
    `${seenProposed.size} proposed path(s) exempt.`,
);
