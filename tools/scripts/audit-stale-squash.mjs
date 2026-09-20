#!/usr/bin/env node
/** Reproduce #3485 from retained PR metadata and Git objects, without network access. */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}
function ancestor(cwd, before, after) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", before, after],
    { cwd },
  );
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`Cannot compare ${before} and ${after}`);
  return result.status === 0;
}
function mergeBase(cwd, left, right) {
  const bases = git(cwd, "merge-base", "--all", left, right).split("\n");
  if (bases.length !== 1)
    throw new Error(`Expected one merge base for ${left} and ${right}`);
  return bases[0];
}
function contentAt(cwd, ref, path) {
  // Verify the commit first. A missing object must not become an empty-file verdict.
  git(cwd, "cat-file", "-e", `${ref}^{commit}`);
  const entries = git(cwd, "ls-tree", "-z", ref, "--", path);
  if (!entries) return "";
  return execFileSync("git", ["show", `${ref}:${path}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
function changedFiles(cwd, left, right) {
  return new Set(
    git(cwd, "diff", "--name-only", "--no-renames", "-z", left, right)
      .split("\0")
      .filter(Boolean),
  );
}
export function missingContent(base, incoming, result) {
  const b = new Set(base.split(/\r?\n/));
  const i = new Set(incoming.split(/\r?\n/));
  const r = new Set(result.split(/\r?\n/));
  return {
    lostMainLines: [...i]
      .filter((line) => line.trim() && !b.has(line) && !r.has(line))
      .sort(),
    restoredRemovedLines: [...b]
      .filter((line) => line.trim() && !i.has(line) && r.has(line))
      .sort(),
  };
}

/** Include final PR bases and earlier merges of main into each retained PR head. */
export function collectBaselines({ cwd, tip, prs }) {
  git(cwd, "cat-file", "-e", `${tip}^{commit}`);
  const records = [];
  const excluded = [];
  const integrations = new Map();
  for (const pr of prs) {
    const merge = pr.mergeCommit.oid;
    const head = pr.headRefOid;
    git(cwd, "cat-file", "-e", `${head}^{commit}`);
    if (!ancestor(cwd, merge, tip)) {
      excluded.push({
        pr: pr.number,
        merge,
        reason: "outside frozen tip ancestry",
      });
      continue;
    }
    const parents = git(cwd, "show", "-s", "--format=%P", merge).split(" ");
    if (parents.length !== 1) {
      excluded.push({
        pr: pr.number,
        merge,
        reason: "not a single-parent squash",
      });
      continue;
    }
    const incoming = parents[0];
    records.push({
      kind: "squash",
      pr: pr.number,
      merge,
      head,
      incoming,
      base: mergeBase(cwd, head, incoming),
      result: merge,
    });
    const merges = git(
      cwd,
      "rev-list",
      "--first-parent",
      "--merges",
      "--parents",
      head,
      "--not",
      incoming,
    );
    for (const row of merges.split("\n").filter(Boolean)) {
      const [integration, local, ...otherParents] = row.split(" ");
      for (const mainParent of otherParents) {
        if (!ancestor(cwd, mainParent, incoming)) continue;
        const key = `${integration}:${mainParent}`;
        if (!integrations.has(key))
          integrations.set(key, {
            kind: "branch-integration",
            prs: [],
            merge: integration,
            local,
            incoming: mainParent,
            base: mergeBase(cwd, local, mainParent),
            result: integration,
          });
        integrations.get(key).prs.push(pr.number);
      }
    }
  }
  return { tip, records: [...records, ...integrations.values()], excluded };
}

/** Line sets are candidate evidence. They cannot establish semantic regressions. */
export function auditBaselines({ cwd, baselines }) {
  const candidates = [];
  for (const record of baselines.records) {
    const changedByMain = changedFiles(cwd, record.base, record.incoming);
    const paths = [...changedFiles(cwd, record.incoming, record.result)]
      .filter((path) => changedByMain.has(path))
      .sort();
    for (const path of paths) {
      const base = contentAt(cwd, record.base, path);
      const incoming = contentAt(cwd, record.incoming, path);
      const result = contentAt(cwd, record.result, path);
      if (`${base}${incoming}${result}`.includes("\0")) {
        candidates.push({ ...record, path, binary: true });
        continue;
      }
      const signal = missingContent(base, incoming, result);
      if (!signal.lostMainLines.length && !signal.restoredRemovedLines.length)
        continue;
      const current = new Set(
        contentAt(cwd, baselines.tip, path).split(/\r?\n/),
      );
      candidates.push({
        ...record,
        path,
        ...signal,
        stillMissing: signal.lostMainLines.filter((line) => !current.has(line)),
        stillRestored: signal.restoredRemovedLines.filter((line) =>
          current.has(line),
        ),
      });
    }
  }
  return candidates;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [metadataPath, tip, outputPrefix] = process.argv.slice(2);
  if (!metadataPath || !tip || !outputPrefix)
    throw new Error(
      "Usage: audit-stale-squash.mjs <PR metadata.json> <frozen tip> <output prefix>",
    );
  const prs = JSON.parse(readFileSync(metadataPath, "utf8"));
  const baselines = collectBaselines({ cwd: process.cwd(), tip, prs });
  const candidates = auditBaselines({ cwd: process.cwd(), baselines });
  writeFileSync(
    `${outputPrefix}-baselines.json`,
    `${JSON.stringify(baselines, null, 2)}\n`,
  );
  writeFileSync(
    `${outputPrefix}-candidates.json`,
    `${JSON.stringify(candidates, null, 2)}\n`,
  );
  console.log(
    `${baselines.records.length} baselines, ${candidates.length} candidate file pairs, ${baselines.excluded.length} excluded PRs`,
  );
}
