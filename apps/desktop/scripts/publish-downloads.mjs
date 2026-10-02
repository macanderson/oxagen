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
 * only the files that belong to --version (default: this package's version):
 * the installers, the bare `oxagen` and `tacho` executables, the macOS
 * updater archives, and the updater's `.sig` files. It hashes them, writes
 * SHA256SUMS.txt to s3://<bucket>/desktop/<version>/ as a conditional write
 * that reserves the version, uploads every file there with the right content
 * type (and a `<file>.sha256` beside each executable), then writes the
 * listing page at the bucket root, copies the page's webfonts beside it, and
 * invalidates both on CloudFront.
 *
 * The page and the version-free links follow the newest version only. When
 * the version being published is at least as new as the one `latest.json`
 * names, each installer and executable is copied server side to
 * `latest/<name>` (the names are in src/downloads.ts; the web app and the
 * docs link them), `latest.json` is rewritten, and the page is redrawn. An
 * older version still gets its immutable `desktop/<version>/` prefix, but
 * moves nothing, so a slow build finishing after a newer one cannot take the
 * links backwards (ADR-158).
 *
 * The in-app update feed, `updater/latest.json`, follows releases only
 * (ADR-247). A release (`X.Y.Z`) built with the updater key rewrites it from
 * the `.sig` files when it is at least as new as the version the feed names.
 * A deploy build never touches it, and neither does a build without
 * signatures.
 *
 * The version is either a release (`X.Y.Z`, from a `desktop-v*` tag) or a
 * build of main (`X.Y.Z-N`) that a production deploy published.
 *
 * `.github/workflows/desktop.yml` runs this with --dir after every tagged
 * build, so a `desktop-v*` tag is enough to update https://downloads.oxagen.sh/;
 * the invocations above are for a build made some other way.
 *
 * --resume is for a re-run of the workflow's publish job after something
 * downstream of the upload failed: when the version is already published,
 * the files on disk are hashed and compared with the published
 * SHA256SUMS.txt. Missing objects are uploaded, the page is redrawn from the
 * bucket, a release rewrites the update feed, and the job carries on. A
 * different set is still refused: that is a new build under an old
 * version's URLs.
 *
 * --page-only rewrites the listing page (and its fonts) for a version that is
 * already published, from what the bucket holds: the object sizes from a
 * listing of `desktop/<version>/` and the digests from its SHA256SUMS.txt.
 * No installer is read or written, and the update feed is left alone. It is
 * how a change to the page's design reaches the live version between
 * releases, and how a version published before `latest/` existed gets its
 * version-free links.
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
  advancesFeed,
  advancesLatest,
  artifactDownloadCurl,
  checksumFileText,
  classifyExecutable,
  classifyInstaller,
  classifyUpdaterArchive,
  decidePublication,
  FONT_FILES,
  isBuildVersion,
  LATEST_CACHE_CONTROL,
  latestCopyArgs,
  latestManifest,
  missingFeedPlatforms,
  readLatestVersion,
  renderIndexHtml,
  reportPublicationDecision,
  reservationArgs,
  sha256SumsText,
  signedFileOf,
  sortExecutables,
  sortInstallers,
  UPDATE_FEED_KEY,
  updateFeed,
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
    "usage: publish-downloads.mjs (--run <id> [--repo owner/name] | --dir <folder> | --page-only) [--version x.y.z] [--bucket name] [--host name] [--allow-overwrite] [--resume] [--dry-run]",
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

/**
 * Run `command`, exiting with its status when it fails. `input` is written to
 * its stdin, which is how a secret reaches it: an argument shows in `ps`,
 * and a failure below prints the arguments.
 */
function sh(
  command,
  args,
  { capture = false, allowFailure = false, input = undefined } = {},
) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: NO_COLOUR_ENV,
    stdio: [
      input === undefined ? (capture ? "ignore" : "inherit") : "pipe",
      capture ? "pipe" : "inherit",
      "inherit",
    ],
    ...(input === undefined ? {} : { input }),
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

/**
 * A temp directory that is removed however the script ends. Most failures
 * end in `process.exit`, which skips any `finally`, so the removal hangs off
 * the `exit` event instead. A signal would end the process without that
 * event, so SIGINT, SIGTERM and SIGHUP exit through it too.
 */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, () => process.exit(128 + osConstants.signals[signal]));

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
function publishPage(dir, entries, executables, publishedAt) {
  const page = join(dir, "index.html");
  writeFileSync(
    page,
    renderIndexHtml({ version, entries, executables, publishedAt }),
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
async function redrawFromBucket({ plannedObjects = [] } = {}) {
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
  const published = [];
  const executables = [];
  for (const object of objects) {
    const name = String(object.Key).split("/").pop();
    const installer = classifyInstaller(name, version);
    const executable = installer === null ? classifyExecutable(name) : null;
    if (installer === null && executable === null) continue;
    const sha256 = digests.get(name);
    if (sha256 === undefined) {
      console.error(
        `✖ ${name} is published but SHA256SUMS.txt does not list it`,
      );
      process.exit(1);
    }
    if (installer !== null)
      published.push({ ...installer, bytes: Number(object.Size), sha256 });
    else executables.push({ ...executable, bytes: Number(object.Size), sha256 });
  }
  // Every file SHA256SUMS.txt lists, and the `.sha256` beside each
  // executable, which moves to `latest/` with it. A publish interrupted before
  // its small files went up would otherwise move `latest/<executable>` and then
  // stop at a checksum that is not there.
  const missing = [
    ...[...digests.keys()].filter((file) => !keys.has(`${keyPrefix}${file}`)),
    ...executables
      .map((e) => `${e.file}.sha256`)
      .filter((file) => !keys.has(`${keyPrefix}${file}`)),
  ];
  if (missing.length > 0) {
    console.error(
      `Installers are missing from ${prefix}/: ${missing.join(", ")}. Resume the upload before publishing.`,
    );
    process.exit(1);
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
  // The executables listed are the ones the bucket holds for this version. A
  // version published before the host carried them (2.1.3 and older) lists
  // none, so the page links nothing that would 404.
  const dir = tempDir("oxagen-downloads-page-");
  const installers = sortInstallers(published);
  const bare = sortExecutables(executables);
  if (advanceLatest(dir, installers, bare, publishedAt)) {
    publishPage(dir, installers, bare, publishedAt);
    invalidate(LATEST_PATHS);
  }
  for (const entry of [...installers, ...bare])
    console.log(`${entry.file}  ${entry.bytes} bytes  ${entry.sha256}`);
  console.log(`https://${host}/`);
  rmSync(dir, { recursive: true, force: true });
  return digests;
}

/**
 * The version the JSON at `key` names (`latest.json` or the update feed), or
 * null when there is none. Anything but "no such key" stops the publish:
 * guessing null here could move the links or the feed backwards, and a
 * re-run with --resume finishes the move.
 */
function publishedVersionAt(key) {
  const result = spawnSync(
    "aws",
    ["s3", "cp", `s3://${bucket}/${key}`, "-", "--only-show-errors"],
    { encoding: "utf8", env: NO_COLOUR_ENV },
  );
  if (result.status === 0) return readLatestVersion(result.stdout);
  const stderr = String(result.stderr ?? "");
  if (/NoSuchKey|\(404\)|Not Found|does not exist/i.test(stderr)) return null;
  console.error(
    `✖ could not read s3://${bucket}/${key}: ${stderr.trim() || `exit ${result.status}`}`,
  );
  process.exit(1);
}

/**
 * Point `latest/` and `latest.json` at `entries` and `executables` when this
 * version is the newest; returns whether it moved. The files must already be
 * under `desktop/<version>/`: the copies are server side. Each executable's
 * `.sha256` moves with it, so `latest/<name>.sha256` checks `latest/<name>`.
 */
function advanceLatest(dir, entries, executables, publishedAt) {
  const current = publishedVersionAt("latest.json");
  if (!advancesLatest(current, version)) {
    console.warn(
      `! latest is ${current}, newer than ${version}; the page and latest/ stay on ${current}`,
    );
    return false;
  }
  const copies = [
    ...entries,
    ...executables.flatMap((e) => [
      e,
      {
        file: `${e.file}.sha256`,
        latest: `${e.latest}.sha256`,
        contentType: CHECKSUM_TYPE,
      },
    ]),
  ];
  for (const entry of copies) {
    const args = latestCopyArgs({ bucket, version, entry });
    if (dryRun) console.log(`[dry-run] aws ${args.join(" ")}`);
    else sh("aws", args);
  }
  const manifest = join(dir, "latest.json");
  writeFileSync(
    manifest,
    `${JSON.stringify(latestManifest({ version, publishedAt, entries, executables, host }), null, 2)}\n`,
  );
  upload(
    manifest,
    `s3://${bucket}/latest.json`,
    "application/json",
    LATEST_CACHE_CONTROL,
  );
  return true;
}

/**
 * Rewrite the in-app update feed for this version, from the signature of
 * each signed file; returns whether it wrote. Only a release at least as new
 * as the one the feed names writes it (ADR-247), and only after every file
 * the feed names is under `desktop/<version>/`. A build made without the
 * updater key has no signatures and leaves the feed as it is, as a deploy
 * build always does.
 */
function publishFeed(dir, signed) {
  if (isBuildVersion(version)) return false;
  if (signed.length === 0) {
    console.warn(
      `! ${version} carries no updater signatures (built without TAURI_SIGNING_PRIVATE_KEY); the update feed is unchanged`,
    );
    return false;
  }
  const current = publishedVersionAt(UPDATE_FEED_KEY);
  if (!advancesFeed(current, version)) {
    console.warn(
      `! the update feed names ${current}, newer than ${version}; it stays on ${current}`,
    );
    return false;
  }
  const feed = updateFeed({
    version,
    pubDate: new Date().toISOString(),
    host,
    signed,
  });
  const missing = missingFeedPlatforms(feed);
  if (missing.length > 0)
    console.warn(
      `! the update feed for ${version} has no ${missing.join(", ")}; apps there are not offered it`,
    );
  const path = join(dir, "update-feed.json");
  writeFileSync(path, `${JSON.stringify(feed, null, 2)}\n`);
  upload(
    path,
    `s3://${bucket}/${UPDATE_FEED_KEY}`,
    "application/json",
    LATEST_CACHE_CONTROL,
  );
  return true;
}

const CHECKSUM_TYPE = "text/plain; charset=utf-8";

const LATEST_PATHS = [
  "/",
  "/index.html",
  "/fonts/*",
  "/latest/*",
  "/latest.json",
];

const FEED_PATH = `/${UPDATE_FEED_KEY}`;

// --page-only: the version is already there; describe it from the bucket.
if (pageOnly) {
  await redrawFromBucket();
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
// them — and leaves no temp directory behind, since it precedes the mkdtemp
// below.
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

/**
 * The repository whose Actions run holds the artifacts, for --run. Never a
 * fixed name: the repository has changed owner more than once. --repo wins,
 * then the runner's GITHUB_REPOSITORY, then the checkout's own remote.
 */
function repository() {
  const named = flag("--repo") ?? process.env.GITHUB_REPOSITORY;
  if (named !== undefined && named !== "") return named;
  return sh(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { capture: true },
  ).trim();
}

// 1. Collect the build outputs.
const work = tempDir("oxagen-downloads-");
let source = fromDir !== undefined ? resolve(fromDir) : work;
if (runId !== undefined) {
  const repo = repository();
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
    const curl = artifactDownloadCurl({
      token,
      out: zip,
      url: `https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
    });
    sh("curl", curl.args, { input: curl.config });
    sh("unzip", ["-q", "-o", zip, "-d", join(work, artifact.name)]);
    rmSync(zip);
  }
  source = work;
}

// 2. Keep the files that belong to this version; refuse a release with no
// installers. Each kind keeps the first file of each name it meets.
const found = new Map();
const bare = new Map();
const archives = new Map();
const signatures = new Map();
for (const path of walk(source)) {
  const name = path.split(/[\\/]/).pop();
  const installer = classifyInstaller(name, version);
  if (installer !== null) {
    if (!found.has(name)) found.set(name, { installer, path });
    continue;
  }
  const executable = classifyExecutable(name);
  if (executable !== null) {
    if (!bare.has(name)) bare.set(name, { executable, path });
    continue;
  }
  const archive = classifyUpdaterArchive(name, version);
  if (archive !== null) {
    if (!archives.has(name)) archives.set(name, { archive, path });
    continue;
  }
  const signedFile = signedFileOf(name, version);
  if (signedFile !== null && !signatures.has(signedFile))
    signatures.set(signedFile, path);
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
const executables = sortExecutables(
  [...bare.values()].map((b) => b.executable),
);
if (executables.length === 0)
  console.warn(
    `! no oxagen or tacho executables for ${version}; the page lists none`,
  );

// 3. Hash every installer, executable, and updater archive, and write
// SHA256SUMS.txt over all of them.
const describe = async (path) => ({
  bytes: statSync(path).size,
  sha256: await sha256(path),
  path,
});
const entries = [];
for (const installer of installers) {
  const path = found.get(installer.file).path;
  entries.push({ ...installer, ...(await describe(path)) });
}
const executableEntries = [];
for (const executable of executables) {
  const path = bare.get(executable.file).path;
  executableEntries.push({
    ...executable,
    ...(await describe(path)),
  });
}
const archiveEntries = [];
for (const { archive, path } of [...archives.values()].sort((a, b) =>
  a.archive.file.localeCompare(b.archive.file),
)) {
  archiveEntries.push({ ...archive, ...(await describe(path)) });
}
const hashed = [...entries, ...executableEntries, ...archiveEntries];
const sums = join(work, "SHA256SUMS.txt");
writeFileSync(sums, sha256SumsText(hashed));

// The small files beside them: a `<file>.sha256` per executable, written here
// from the digest just taken, and the updater's `<file>.sig` per signed file.
// Neither goes in SHA256SUMS.txt, since each is a check on a file that does.
const sidecarDir = tempDir("oxagen-downloads-sidecars-");
const sidecars = [
  ...executableEntries.map((e) => {
    const path = join(sidecarDir, `${e.file}.sha256`);
    writeFileSync(path, checksumFileText(e));
    return { file: `${e.file}.sha256`, path, contentType: CHECKSUM_TYPE };
  }),
  ...[...signatures]
    .filter(([file]) => hashed.some((e) => e.file === file))
    .map(([file, path]) => ({
      file: `${file}.sig`,
      path,
      contentType: CHECKSUM_TYPE,
    })),
];
// What the update feed is written from: each signed file and the text of its
// signature, which the app checks against its public key before installing.
const signed = [...signatures]
  .filter(([file]) => hashed.some((e) => e.file === file))
  .map(([file, path]) => ({ file, signature: readFileSync(path, "utf8") }));

// A retry must use the same build before it can repair missing objects.
// Verify the complete bucket listing before the job's later steps run.
// Anything else is a different build asking for an old version's immutable
// URLs, which is what the refusal above exists to stop.
if (resuming) {
  const published = readPublishedDigests();
  const differs = hashed.filter((e) => published.get(e.file) !== e.sha256);
  const missing = [...published.keys()].filter(
    (file) => !hashed.some((e) => e.file === file),
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
  for (const entry of [...hashed, ...sidecars]) {
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
          Size: statSync(entry.path).size,
        });
      }
    }
  }
  await redrawFromBucket({ plannedObjects });
  if (publishFeed(work, signed)) invalidate([FEED_PATH]);
  console.log(
    dryRun
      ? `[dry-run] ${version} installer recovery and page publication planned.`
      : `${version} has every installer; page redrawn.`,
  );
  rmSync(work, { recursive: true, force: true });
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

for (const entry of [...hashed, ...sidecars]) {
  upload(entry.path, `${prefix}/${entry.file}`, entry.contentType, immutable);
}

// 5. Move latest/ and the page when this is the newest version, then the
// update feed when this is a release at least as new as the one it names.
// Both come after the uploads, so neither names a file that is not there.
const publishedAt = new Date().toISOString().slice(0, 10);
const moved = advanceLatest(work, entries, executableEntries, publishedAt);
if (moved) publishPage(work, entries, executableEntries, publishedAt);
const fed = publishFeed(work, signed);

// 6. Invalidate what changed when the distribution exists. Only an
// --allow-overwrite republish can have a stale edge copy of the versioned
// prefix, and only the edge is reachable: anything further downstream was
// promised a year. Invalidating a prefix that was never cached costs nothing,
// so it is always included.
invalidate([
  ...(moved ? LATEST_PATHS : []),
  ...(fed ? [FEED_PATH] : []),
  `/desktop/${version}/*`,
]);

for (const entry of hashed)
  console.log(
    `https://${host}/desktop/${version}/${encodeURIComponent(entry.file)}`,
  );
console.log(`https://${host}/desktop/${version}/SHA256SUMS.txt`);
if (moved)
  for (const entry of [...entries, ...executableEntries])
    console.log(`https://${host}/latest/${encodeURIComponent(entry.latest)}`);
if (fed) console.log(`https://${host}/${UPDATE_FEED_KEY}`);
console.log(`https://${host}/`);
rmSync(work, { recursive: true, force: true });
