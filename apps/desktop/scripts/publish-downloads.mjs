#!/usr/bin/env node
/**
 * Publish a desktop release to https://downloads.oxagen.sh/.
 *
 *   node scripts/publish-downloads.mjs --run <actions run id>   [--version 2.1.1] [--dry-run]
 *   node scripts/publish-downloads.mjs --dir <folder of installers> [--version 2.1.1] [--dry-run]
 *   node scripts/publish-downloads.mjs --page-only                [--version 2.1.1] [--dry-run]
 *   node scripts/publish-downloads.mjs --dir <folder> --resume    (CI: a re-run after a partial failure)
 *
 * With --run it fetches every artifact of a `.github/workflows/desktop.yml`
 * run; with --dir it takes installers already on disk. Either way it keeps
 * only the files that are installers for --version (default: this package's
 * version), hashes them, writes SHA256SUMS.txt to
 * s3://<bucket>/desktop/<version>/ as a conditional write that reserves the
 * version, uploads the installers there with the right content types, then
 * writes the listing page at the bucket root, copies the page's webfonts
 * beside it, and invalidates both on CloudFront.
 *
 * `.github/workflows/desktop.yml` runs this with --dir after every tagged
 * build, so a `desktop-v*` tag is enough to update https://downloads.oxagen.sh/;
 * the invocations above are for a build made some other way.
 *
 * --resume is for a re-run of the workflow's publish job after something
 * downstream of the upload failed: when the version is already published,
 * the installers on disk are hashed and compared with the published
 * SHA256SUMS.txt. Missing objects are uploaded before the page is redrawn
 * from the bucket and the job carries on. A different set is still
 * refused: that is a new build under an old version's URLs.
 *
 * --page-only rewrites the listing page (and its fonts) for a version that is
 * already published, from what the bucket holds: the object sizes from a
 * listing of `desktop/<version>/` and the digests from its SHA256SUMS.txt.
 * No installer is read or written. It is how a change to the page's design
 * reaches the live version between releases.
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
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactDownloadCurl,
  classifyInstaller,
  decidePublication,
  FONT_FILES,
  renderIndexHtml,
  reportPublicationDecision,
  reservationArgs,
  sha256SumsText,
  sortInstallers,
  tempDirTracker,
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
const pageOnly = argv.includes("--page-only");
const resume = argv.includes("--resume");
const repo = flag("--repo") ?? "macanderson/oxagen";
const bucket = flag("--bucket") ?? "oxagen-downloads-916294258235";
const host = flag("--host") ?? "downloads.oxagen.sh";
const version =
  flag("--version") ??
  JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;

const sources = [runId !== undefined, fromDir !== undefined, pageOnly].filter(
  Boolean,
).length;
if (sources !== 1) {
  console.error(
    "usage: publish-downloads.mjs (--run <id> | --dir <folder> | --page-only) [--version x.y.z] [--bucket name] [--host name] [--allow-overwrite] [--resume] [--dry-run]",
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
  // Same hazard from a different direction: an inherited AWS_PAGER sends
  // captured JSON through a pager instead of the pipe this script reads.
  AWS_PAGER: "",
};

// Every temporary directory this run makes is removed when the process exits,
// on every path: a refusal's process.exit, a failed child in sh(), an uncaught
// error, or one of the signals below. See tempDirTracker in ../src/downloads.ts.
// A signal handler runs on the event loop, so a signal that arrives while
// spawnSync is blocked on a child is handled once that child returns. Ctrl-C
// reaches the child too, which then fails and exits through sh().
const temps = tempDirTracker(
  (path) => rmSync(path, { recursive: true, force: true }),
  (path, error) => console.warn(`! could not remove ${path}: ${String(error)}`),
);
process.on("exit", temps.cleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => process.exit(128 + osConstants.signals[signal]));
}
const makeTempDir = (prefix) =>
  temps.track(mkdtempSync(join(tmpdir(), prefix)));

/**
 * Run `command`. `input`, when given, is written to the child's stdin, which
 * is how a secret reaches a child without appearing on its argv.
 */
function sh(
  command,
  args,
  { capture = false, allowFailure = false, input } = {},
) {
  const stdin = input !== undefined ? "pipe" : capture ? "ignore" : "inherit";
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: NO_COLOUR_ENV,
    input,
    stdio: [stdin, capture ? "pipe" : "inherit", "inherit"],
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

const keyPrefix = `desktop/${version}/`;
const prefix = `s3://${bucket}/desktop/${version}`;
const immutable = "public, max-age=31536000, immutable";

function upload(path, key, contentType, cacheControl) {
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
}

/**
 * Render the listing for `entries` and put it at the bucket root with the
 * page's fonts beside it. The page is short-lived because it moves with every
 * release; the fonts are the kit's files as vendored into apps/web/fonts by
 * tools/scripts/sync-brand-assets.mjs, which change only when the kit does,
 * so a week in caches is safe (the path is invalidated when they are
 * re-uploaded).
 */
function publishPage(dir, entries, publishedAt, cliRelease = true) {
  const page = join(dir, "index.html");
  writeFileSync(
    page,
    renderIndexHtml({ version, entries, publishedAt, cliRelease }),
  );
  upload(
    page,
    `s3://${bucket}/index.html`,
    "text/html; charset=utf-8",
    "public, max-age=300",
  );
  const fontsDir = resolve(here, "..", "..", "web", "fonts");
  for (const file of FONT_FILES) {
    upload(
      join(fontsDir, file),
      `s3://${bucket}/fonts/${file}`,
      "font/woff2",
      "public, max-age=604800",
    );
  }
}

/** Invalidate `paths` on the distribution that serves the host, if any. */
function invalidate(paths) {
  if (dryRun) {
    console.log(
      `[dry-run] aws cloudfront create-invalidation ${paths.join(" ")}`,
    );
    return;
  }
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
  if (ids === "" || ids === "None") {
    console.warn(
      `! no CloudFront distribution serves ${host} yet; skipped invalidation`,
    );
    return;
  }
  sh("aws", [
    "cloudfront",
    "create-invalidation",
    "--distribution-id",
    ids.split(/\s+/)[0],
    "--paths",
    ...paths,
  ]);
}

/** The published SHA256SUMS.txt, as file name → digest. */
function readPublishedDigests() {
  const sumsText = sh(
    "aws",
    ["s3", "cp", `${prefix}/SHA256SUMS.txt`, "-", "--only-show-errors"],
    { capture: true },
  );
  return new Map(
    sumsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const [sha256, ...rest] = line.split(/\s+/);
        return [rest.join(" ").replace(/^\*/, ""), sha256];
      }),
  );
}

/** List every object under this release prefix. */
function listPublishedObjects() {
  const listing = JSON.parse(
    sh(
      "aws",
      [
        "s3api",
        "list-objects-v2",
        "--bucket",
        bucket,
        "--prefix",
        keyPrefix,
        "--output",
        "json",
        "--no-cli-pager",
      ],
      { capture: true },
    ) || "{}",
  );
  return Array.isArray(listing.Contents) ? listing.Contents : [];
}

/** Refuse incomplete releases before replacing the public download page. */
async function redrawFromBucket({ probeCliRelease, plannedObjects = [] }) {
  const objects = [
    ...listPublishedObjects(),
    ...(dryRun ? plannedObjects : []),
  ];
  if (objects.length === 0) {
    console.error(
      `✖ nothing is published under ${prefix}/; --page-only needs a published version`,
    );
    process.exit(1);
  }
  const digests = readPublishedDigests();
  const keys = new Set(objects.map((object) => object.Key));
  const missing = [...digests.keys()].filter(
    (file) => !keys.has(`${keyPrefix}${file}`),
  );
  if (missing.length > 0) {
    console.error(
      `Installers are missing from ${prefix}/: ${missing.join(", ")}. Resume the upload before publishing.`,
    );
    process.exit(1);
  }
  const published = [];
  for (const object of objects) {
    const name = String(object.Key).split("/").pop();
    const installer = classifyInstaller(name, version);
    if (installer === null) continue;
    const sha256 = digests.get(name);
    if (sha256 === undefined) {
      console.error(
        `✖ ${name} is published but SHA256SUMS.txt does not list it`,
      );
      process.exit(1);
    }
    published.push({ ...installer, bytes: Number(object.Size), sha256 });
  }
  if (published.length === 0) {
    console.error(`✖ no installers for ${version} under ${prefix}/`);
    process.exit(1);
  }
  // The page says when the version was published, not when it was redrawn:
  // the checksum file is written first on a publish, so its date is that.
  const sumsObject = objects.find(
    (o) => o.Key === `${keyPrefix}SHA256SUMS.txt`,
  );
  const publishedAt =
    String(sumsObject?.LastModified ?? "").slice(0, 10) ||
    new Date().toISOString().slice(0, 10);
  // A version published before the release workflow existed has no
  // desktop-v release with the bare binaries; do not link one that 404s. A
  // resumed publish skips the probe: its release is a draft at this point
  // (which HEAD reports as absent) and the job publishes it moments later.
  let cliRelease = true;
  if (probeCliRelease) {
    const releaseUrl = `https://github.com/${repo}/releases/tag/desktop-v${version}`;
    cliRelease = await fetch(releaseUrl, { method: "HEAD", redirect: "manual" })
      .then((r) => r.status === 200)
      .catch(() => false);
    if (!cliRelease)
      console.warn(
        `! ${releaseUrl} does not exist; the page omits the bare-binary link`,
      );
  }
  const dir = makeTempDir("oxagen-downloads-page-");
  publishPage(dir, sortInstallers(published), publishedAt, cliRelease);
  invalidate(["/", "/index.html", "/fonts/*"]);
  for (const entry of sortInstallers(published))
    console.log(`${entry.file}  ${entry.bytes} bytes  ${entry.sha256}`);
  console.log(`https://${host}/`);
  return digests;
}

// --page-only: the version is already there; describe it from the bucket.
if (pageOnly) {
  await redrawFromBucket({ probeCliRelease: true });
  process.exit(0);
}

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
// The probe runs before anything is fetched, so a refusal costs one request
// rather than ~500 MB of downloaded artifacts and a pass of SHA-256 over
// them. The temp directory made below is removed on every exit path by the
// tracker registered at the top of this file.
//
// `s3api list-objects-v2` rather than `s3 ls`, because this guard must be
// able to tell "nothing is there" from "I could not find out" and `s3 ls`
// cannot say it: given a key it runs `_check_no_objects()` and exits 1 for a
// prefix that holds nothing, so 1 means both "empty" and, per the documented
// return codes, "the S3 command failed". A guard that reads a failure as
// "empty" fails open exactly when it matters — an expired session, a
// transient S3 error, or a principal holding PutObject without ListBucket
// would all wave a republish through. `list-objects-v2` exits 0 only when the
// listing succeeded, so here every nonzero status, every signal, and every
// unreadable answer stops the publish. `--max-keys 1` also turns the CLI's
// own pagination off, so what comes back is the one raw response, KeyCount
// and all, rather than a merged result whose shape depends on the page count.
const probe = sh(
  "aws",
  [
    "s3api",
    "list-objects-v2",
    "--bucket",
    bucket,
    "--prefix",
    keyPrefix,
    "--max-keys",
    "1",
    "--output",
    "json",
    "--no-cli-pager",
  ],
  { capture: true, allowFailure: true },
);
const decision = decidePublication(probe, { version, prefix, allowOverwrite });
// --dry-run performs no writes, so it is told what the real run would have
// decided and then shown the plan anyway; only a real publish stops. See
// reportPublicationDecision, which is the one place that distinction is made.
const resuming =
  resume && decision.action === "stop" && decision.reason === "published";
if (resuming) {
  console.warn(
    `! ${version} is already published; --resume will compare the build on disk with it`,
  );
} else {
  const report = reportPublicationDecision(decision, { dryRun });
  if (report.message !== null)
    (report.level === "error" ? console.error : console.warn)(report.message);
  if (report.exitCode !== null) process.exit(report.exitCode);
}

// 1. Collect the build outputs.
const work = makeTempDir("oxagen-downloads-");
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
    // The token reaches curl on stdin, not the argv: see artifactDownloadCurl.
    const download = artifactDownloadCurl({
      token,
      output: zip,
      url: `https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
    });
    sh("curl", download.args, { input: download.config });
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

// 3. Hash and write SHA256SUMS.txt.
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

// A retry must use the same build before it can repair missing objects.
// Verify the complete bucket listing before the job's later steps run.
// Anything else is a different build asking for an old version's immutable
// URLs, which is what the refusal above exists to stop.
if (resuming) {
  const published = readPublishedDigests();
  const differs = entries.filter((e) => published.get(e.file) !== e.sha256);
  const missing = [...published.keys()].filter(
    (file) => !entries.some((e) => e.file === file),
  );
  if (differs.length > 0 || missing.length > 0) {
    console.error(
      `✖ the build on disk is not the ${version} that is published:\n` +
        [
          ...differs.map((e) => `  ${e.file} has a different digest`),
          ...missing.map((f) => `  ${f} is published but not on disk`),
        ].join("\n") +
        "\n  Ship the fix as a new version.",
    );
    process.exit(1);
  }
  const keys = new Set(listPublishedObjects().map((object) => object.Key));
  const plannedObjects = [];
  for (const entry of entries) {
    if (!keys.has(`${keyPrefix}${entry.file}`)) {
      upload(
        entry.path,
        `${prefix}/${entry.file}`,
        entry.contentType,
        immutable,
      );
      if (dryRun) {
        plannedObjects.push({
          Key: `${keyPrefix}${entry.file}`,
          Size: entry.bytes,
        });
      }
    }
  }
  await redrawFromBucket({ probeCliRelease: false, plannedObjects });
  console.log(
    dryRun
      ? `[dry-run] ${version} installer recovery and page publication planned.`
      : `${version} has every installer; page redrawn.`,
  );
  process.exit(0);
}

// 4. Reserve the version, then upload. Versioned paths are immutable (a fix
// ships as a new version, enforced above), so they cache for a year.
//
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
publishPage(work, entries, new Date().toISOString().slice(0, 10));

// 5. Invalidate the page when the distribution exists. Only an
// --allow-overwrite republish can have a stale edge copy of the versioned
// prefix, and only the edge is reachable: anything further downstream was
// promised a year. Invalidating a prefix that was never cached costs nothing,
// so it is always included.
invalidate(["/", "/index.html", "/fonts/*", `/desktop/${version}/*`]);

for (const entry of entries)
  console.log(
    `https://${host}/desktop/${version}/${encodeURIComponent(entry.file)}`,
  );
console.log(`https://${host}/desktop/${version}/SHA256SUMS.txt`);
console.log(`https://${host}/`);
