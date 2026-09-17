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
 * version), hashes them, writes SHA256SUMS.txt to
 * s3://<bucket>/desktop/<version>/ as a conditional write that reserves the
 * version, uploads the installers there with the right content types, then
 * writes the listing page at the bucket root and invalidates it on CloudFront.
 *
 * Versioned URLs are served immutable, so a version that is already published
 * is refused, and a version two invocations race for is won by one of them:
 * a fix ships as a new version. --allow-overwrite is the escape hatch for a
 * publish nobody was given the URLs to.
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
  decidePublication,
  renderIndexHtml,
  reservationArgs,
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
  // `status` is null when the process never ran (spawn failed) or was killed
  // by a signal. Coercing that to a number would let "aws was not on PATH" or
  // "aws was OOM-killed" arrive at a caller as an exit code the CLI never
  // produced, so the raw outcome is handed over intact and every caller that
  // tolerates failure decides for itself.
  if (allowFailure)
    return {
      status: result.status,
      signal: result.signal ?? null,
      spawnFailed: result.error !== undefined,
      stdout: result.stdout ?? "",
    };
  if (result.status !== 0) {
    console.error(`✖ ${command} ${args.join(" ")} exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
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

const prefix = `s3://${bucket}/desktop/${version}`;
const keyPrefix = `desktop/${version}/`;

// `immutable, max-age=31536000` is a promise to every cache that fetched the
// URL, not just to CloudFront. Overwriting the object cannot take that promise
// back: a browser or a corporate proxy that already downloaded the installer
// will keep serving its copy for the rest of the year without revalidating,
// and an invalidation only reaches the edge. So a corrected build has to ship
// under a new version, and this refuses to republish one rather than leave the
// fleet split between two different files answering to one URL and one
// checksum. --allow-overwrite is for the publish that failed before anyone was
// given the URL, where nothing downstream can hold a stale copy.
//
// The probe is `s3api list-objects-v2`, not `aws s3 ls`, because this guard
// must be able to tell "nothing is there" from "I could not find out", and
// `s3 ls` cannot say it: given a key it runs `_check_no_objects()` and exits 1
// for a prefix that holds nothing, so 1 means both "empty" and, per the
// documented return codes, "the S3 command failed". A guard that reads a
// failure as "empty" fails open exactly when it matters — an expired session,
// a transient S3 error, or a principal holding PutObject without ListBucket
// would all wave a republish through. `list-objects-v2` exits 0 only when the
// listing succeeded, so here every nonzero status, every signal, and every
// unreadable answer stops the publish.
//
// It runs before anything is fetched, so a refusal costs one ListObjects
// rather than ~500 MB of downloaded artifacts and a pass of SHA-256 over
// them — and leaves no temp directory behind, since it precedes the mkdtemp
// below.
const probe = sh(
  "aws",
  [
    "s3api",
    "list-objects-v2",
    "--bucket",
    bucket,
    "--prefix",
    keyPrefix,
    "--max-items",
    "1",
    "--output",
    "json",
    "--no-cli-pager",
  ],
  { capture: true, allowFailure: true },
);
const decision = decidePublication(probe, { version, prefix, allowOverwrite });
if (decision.action === "stop") {
  console.error(decision.message);
  process.exit(decision.code);
}
if (decision.action === "overwrite") console.warn(decision.message);

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

// 4. Reserve the version, then upload. Versioned paths are immutable (a fix
// ships as a new version, enforced above), so they cache for a year; the page
// is short-lived because it moves with every release.
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

// The listing above is a check, and a check cannot stop two publishes of the
// same new version from both seeing an empty prefix before either has written
// anything — after which their uploads interleave and the fleet can end up
// with one invocation's installers under URLs a second invocation's
// SHA256SUMS.txt claims to describe. So the version is *reserved* rather than
// merely checked: SHA256SUMS.txt goes up first with `--if-none-match "*"`, an
// S3 conditional write that the storage layer resolves atomically, and the
// loser of the race is refused with 412 before it uploads a single installer.
// The checksum file doubles as the claim ticket because it exists anyway and
// is the one object that must describe exactly this invocation's build; a
// window where it is public and the installers are not is a 404 on a link
// nothing published yet, whereas the reverse is a checksum mismatch.
// --allow-overwrite drops the condition, since that flag exists precisely to
// overwrite what is already there.
const sumsKey = `${keyPrefix}SHA256SUMS.txt`;
const reserveArgs = reservationArgs({
  bucket,
  key: sumsKey,
  body: sums,
  cacheControl: immutable,
  allowOverwrite,
});
if (dryRun) {
  console.log(`[dry-run] aws ${reserveArgs.join(" ")}`);
} else {
  const reserved = sh("aws", reserveArgs, {
    capture: true,
    allowFailure: true,
  });
  if (
    reserved.spawnFailed ||
    reserved.signal !== null ||
    reserved.status !== 0
  ) {
    console.error(
      `✖ could not reserve ${version} by writing s3://${bucket}/${sumsKey}.\n` +
        "  If aws reported PreconditionFailed, another publish of this version\n" +
        "  claimed it first and this one must stop: ship the fix as a new\n" +
        "  version. Otherwise the upload itself failed — nothing was written,\n" +
        "  so re-running is safe. (--if-none-match needs aws-cli >= 2.17.)",
    );
    process.exit(1);
  }
}

for (const entry of entries) {
  upload(entry.path, `${prefix}/${entry.file}`, entry.contentType, immutable);
}
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
