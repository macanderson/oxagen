#!/usr/bin/env tsx
/**
 * Drift gate for the `contextgraph-trace` fixtures vendored into
 * `packages/tacho/fixtures/contextgraph-trace/` (the ADR-035 pattern applied
 * to the trace crate). Offline it verifies every vendored file against the
 * digests frozen here; given a canonical checkout via
 * `CONTEXT_GRAPH_PROTOCOL_DIR` it upgrades to full byte parity at the pinned
 * commit.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_TRACE_FORMAT = "contextgraph-trace/0.1-sketch";
const EXPECTED_UPSTREAM_REPOSITORY =
  "https://github.com/macanderson/context-graph-protocol";
const EXPECTED_UPSTREAM_PATH = "contextgraph-trace/fixtures";
const EXPECTED_UPSTREAM_COMMIT = "98e32ff217e4e0b8e9be078131d0a0728eb77c06";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const FIXTURES = resolve(ROOT, "packages/tacho/fixtures/contextgraph-trace");

interface Manifest {
  upstream_repository: string;
  upstream_commit: string;
  upstream_path: string;
  trace_format: string;
  files: Record<string, string>;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fail(message: string): never {
  console.error(`check-tacho-fixtures: ${message}`);
  process.exit(1);
}

const manifest = JSON.parse(
  readFileSync(resolve(FIXTURES, "manifest.json"), "utf8"),
) as Manifest;
if (manifest.trace_format !== EXPECTED_TRACE_FORMAT)
  fail(
    `trace_format is ${manifest.trace_format}, expected ${EXPECTED_TRACE_FORMAT}`,
  );
if (manifest.upstream_repository !== EXPECTED_UPSTREAM_REPOSITORY)
  fail(`upstream_repository is ${manifest.upstream_repository}`);
if (manifest.upstream_path !== EXPECTED_UPSTREAM_PATH)
  fail(`upstream_path is ${manifest.upstream_path}`);
if (manifest.upstream_commit !== EXPECTED_UPSTREAM_COMMIT)
  fail(
    `upstream_commit is ${manifest.upstream_commit}, expected ${EXPECTED_UPSTREAM_COMMIT}`,
  );

const onDisk = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".ndjson"))
  .sort();
const listed = Object.keys(manifest.files).sort();
if (JSON.stringify(onDisk) !== JSON.stringify(listed))
  fail(
    `files on disk ${JSON.stringify(onDisk)} differ from manifest ${JSON.stringify(listed)}`,
  );
for (const [name, digest] of Object.entries(manifest.files)) {
  const actual = sha256(readFileSync(resolve(FIXTURES, name)));
  if (actual !== digest)
    fail(`${name} digest ${actual} differs from manifest ${digest}`);
}

const upstreamDir = process.env["CONTEXT_GRAPH_PROTOCOL_DIR"];
if (upstreamDir) {
  const head = execFileSync("git", ["-C", upstreamDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head !== EXPECTED_UPSTREAM_COMMIT)
    fail(
      `upstream checkout is at ${head}, expected ${EXPECTED_UPSTREAM_COMMIT}`,
    );
  for (const name of listed) {
    const upstream = readFileSync(
      resolve(upstreamDir, EXPECTED_UPSTREAM_PATH, name),
    );
    const local = readFileSync(resolve(FIXTURES, name));
    if (!upstream.equals(local))
      fail(`${name} is not byte-identical to upstream`);
  }
  console.log(
    `check-tacho-fixtures: ${listed.length} fixture(s) byte-identical to upstream ${head.slice(0, 8)}`,
  );
} else {
  console.log(
    `check-tacho-fixtures: ${listed.length} fixture(s) match frozen digests (set CONTEXT_GRAPH_PROTOCOL_DIR for byte parity)`,
  );
}
