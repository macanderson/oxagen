#!/usr/bin/env node
/**
 * Publish a desktop release to https://downloads.oxagen.sh/.
 *
 *   node scripts/publish-downloads.mjs --run <actions run id>   [--version 2.1.1] [--dry-run]
 *   node scripts/publish-downloads.mjs --dir <folder of installers> [--version 2.1.1] [--dry-run]
 *
 * With --run it fetches every artifact of a `.github/workflows/desktop.yml`
 * run; with --dir it takes installers already on disk. Either way it keeps
 * only the files that are installers for --version (default: this package's
 * version), hashes them, and uploads to s3://<bucket>/desktop/<version>/
 * with the right content types, then writes SHA256SUMS.txt there and the
 * listing page at the bucket root, and invalidates the page on CloudFront.
 *
 * Versioned URLs are served immutable, so a version that is already published
 * is refused: a fix ships as a new version. --allow-overwrite is the escape
 * hatch for a publish nobody was given the URLs to.
 *
 * Artifacts are streamed to disk with curl rather than `gh run download`,
 * which holds each zip in memory and is killed on a loaded machine (the
 * Windows artifact alone is ~190 MB). Needs `gh` (signed in), `aws`
 * (credentials for the bucket and distribution), `curl` and `unzip`.
 *
 * Requires Node >= 22.18 or 23.6: `../src/downloads.ts` is imported through
 * Node's built-in type stripping, so there is no build step.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyInstaller,
  renderIndexHtml,
  sha256SumsText,
  sortInstallers,
} from "../src/downloads.ts";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = argv.includes("--dry-run");
const allowOverwrite = argv.includes("--allow-overwrite");
const runId = flag("--run");
const fromDir = flag("--dir");
const repo = flag("--repo") ?? "macanderson/oxagen";
const bucket = flag("--bucket") ?? "oxagen-downloads-916294258235";
const host = flag("--host") ?? "downloads.oxagen.sh";
const version =
  flag("--version") ??
  JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;

if ((runId === undefined) === (fromDir === undefined)) {
  console.error(
    "usage: publish-downloads.mjs (--run <id> | --dir <folder>) [--version x.y.z] [--bucket name] [--host name] [--allow-overwrite] [--dry-run]",
  );
  process.exit(2);
}

// Colour-forcing variables in the caller's shell (CLICOLOR_FORCE=1 is common in
// an interactive zsh profile) make `gh` emit ANSI escapes even when its stdout
// is a pipe, and `JSON.parse` on that fails with an unreadable "Unexpected token
// ''" pointing at the first escape byte. The machine-readable output this script
// depends on must not vary with whoever is running it, so every child process
// gets colour forced off rather than inherited.
const NO_COLOUR_ENV = {
  ...process.env,
  NO_COLOR: "1",
  CLICOLOR: "0",
  CLICOLOR_FORCE: "0",
  FORCE_COLOR: "0",
  GH_FORCE_TTY: "",
};

function sh(command, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: NO_COLOUR_ENV,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.status !== 0 && !allowFailure) {
    console.error(`✖ ${command} ${args.join(" ")} exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
  if (allowFailure)
    return { status: result.status ?? 1, stdout: result.stdout ?? "" };
  return capture ? result.stdout : "";
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function sha256(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(hash.digest("hex")))
      .on("error", reject);
  });
}

// 1. Collect the build outputs.
const work = mkdtempSync(join(tmpdir(), "oxagen-downloads-"));
let source = fromDir !== undefined ? resolve(fromDir) : work;
if (runId !== undefined) {
  const listing = JSON.parse(
    sh(
      "gh",
      ["api", `repos/${repo}/actions/runs/${runId}/artifacts`, "--paginate"],
      { capture: true },
    ),
  );
  const token = sh("gh", ["auth", "token"], { capture: true }).trim();
  const artifacts = (listing.artifacts ?? []).filter((a) =>
    a.name.startsWith("oxagen-desktop-"),
  );
  if (artifacts.length === 0) {
    console.error(`✖ run ${runId} has no oxagen-desktop-* artifacts`);
    process.exit(1);
  }
  for (const artifact of artifacts) {
    const zip = join(work, `${artifact.name}.zip`);
    console.log(
      `↓ ${artifact.name} (${(artifact.size_in_bytes / 1e6).toFixed(0)} MB)`,
    );
    sh("curl", [
      "-sSL",
      "--retry",
      "5",
      "--retry-all-errors",
      "--retry-delay",
      "10",
      "-H",
      `Authorization: Bearer ${token}`,
      "-o",
      zip,
      `https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
    ]);
    sh("unzip", ["-q", "-o", zip, "-d", join(work, artifact.name)]);
    rmSync(zip);
  }
  source = work;
}

// 2. Keep the installers for this version; refuse a partial release.
const found = new Map();
for (const path of walk(source)) {
  const name = path.split(/[\\/]/).pop();
  const installer = classifyInstaller(name, version);
  if (installer !== null && !found.has(name))
    found.set(name, { installer, path });
}
const installers = sortInstallers([...found.values()].map((f) => f.installer));
if (installers.length === 0) {
  console.error(`✖ no installers for ${version} under ${source}`);
  process.exit(1);
}
const oses = new Set(installers.map((i) => i.os));
for (const os of ["macOS", "Windows", "Linux"]) {
  if (!oses.has(os))
    console.warn(`! no ${os} installer for ${version}; the page will omit it`);
}

// 3. Hash, write SHA256SUMS.txt and the page.
const entries = [];
for (const installer of installers) {
  const path = found.get(installer.file).path;
  entries.push({
    ...installer,
    bytes: statSync(path).size,
    sha256: await sha256(path),
    path,
  });
}
const sums = join(work, "SHA256SUMS.txt");
writeFileSync(sums, sha256SumsText(entries));
const page = join(work, "index.html");
writeFileSync(
  page,
  renderIndexHtml({
    version,
    entries,
    publishedAt: new Date().toISOString().slice(0, 10),
  }),
);

// 4. Upload. Versioned paths are immutable (a fix ships as a new version),
// so they cache for a year; the page is short-lived because it moves with
// every release.
const prefix = `s3://${bucket}/desktop/${version}`;

// `immutable, max-age=31536000` is a promise to every cache that fetched the
// URL, not just to CloudFront. Overwriting the object cannot take that promise
// back: a browser or a corporate proxy that already downloaded the installer
// will keep serving its copy for the rest of the year without revalidating,
// and an invalidation only reaches the edge. So a corrected build has to ship
// under a new version, and this refuses to republish one rather than leave the
// fleet split between two different files answering to one URL and one
// checksum. --allow-overwrite is for the publish that failed before anyone was
// given the URL, where nothing downstream can hold a stale copy.
const published = sh("aws", ["s3", "ls", `${prefix}/`], {
  capture: true,
  allowFailure: true,
});
if (published.status === 0 && published.stdout.trim() !== "") {
  if (!allowOverwrite) {
    console.error(
      `✖ ${version} is already published at ${prefix}/.\n` +
        "  Those URLs were served as immutable, so caches downstream of\n" +
        "  CloudFront may hold the old installers for up to a year and no\n" +
        "  invalidation can reach them. Ship the fix as a new version.\n" +
        "  If nobody was ever given these URLs, re-run with --allow-overwrite.",
    );
    process.exit(1);
  }
  console.warn(
    `! overwriting the published ${version}; only caches that never fetched\n` +
      "  these URLs will see the new installers",
  );
}

const upload = (path, key, contentType, cacheControl) => {
  const args = [
    "s3",
    "cp",
    path,
    key,
    "--content-type",
    contentType,
    "--cache-control",
    cacheControl,
    "--only-show-errors",
  ];
  if (dryRun) console.log(`[dry-run] aws ${args.join(" ")}`);
  else sh("aws", args);
};
const immutable = "public, max-age=31536000, immutable";
for (const entry of entries) {
  upload(entry.path, `${prefix}/${entry.file}`, entry.contentType, immutable);
}
upload(
  sums,
  `${prefix}/SHA256SUMS.txt`,
  "text/plain; charset=utf-8",
  immutable,
);
upload(
  page,
  `s3://${bucket}/index.html`,
  "text/html; charset=utf-8",
  "public, max-age=300",
);

// 5. Invalidate the page when the distribution exists.
if (!dryRun) {
  const ids = sh(
    "aws",
    [
      "cloudfront",
      "list-distributions",
      "--query",
      `DistributionList.Items[?contains(Aliases.Items, '${host}')].Id`,
      "--output",
      "text",
    ],
    { capture: true },
  ).trim();
  if (ids !== "" && ids !== "None") {
    sh("aws", [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      ids.split(/\s+/)[0],
      "--paths",
      "/",
      "/index.html",
      // Only an --allow-overwrite republish can have a stale edge copy of the
      // versioned prefix, and only the edge is reachable — anything further
      // downstream was promised a year. Invalidating a prefix that was never
      // cached costs nothing, so this runs unconditionally.
      `/desktop/${version}/*`,
    ]);
  } else {
    console.warn(
      `! no CloudFront distribution serves ${host} yet; skipped invalidation`,
    );
  }
}

for (const entry of entries)
  console.log(
    `https://${host}/desktop/${version}/${encodeURIComponent(entry.file)}`,
  );
console.log(`https://${host}/desktop/${version}/SHA256SUMS.txt`);
console.log(`https://${host}/`);
rmSync(work, { recursive: true, force: true });
