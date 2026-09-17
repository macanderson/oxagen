/**
 * The pure half of `scripts/publish-downloads.mjs`: which build outputs are
 * installers, what each one is for, the content type S3 serves it with, the
 * `SHA256SUMS.txt` line format, and the `index.html` that lists a version on
 * https://downloads.oxagen.sh/. Kept in `src/` so the coverage gate reaches
 * it; written with erasable-only TypeScript so the script can import it with
 * Node's built-in type stripping and no build step.
 */

export interface Installer {
  /** File name as published, e.g. `Oxagen_2.1.1_aarch64.dmg`. */
  file: string;
  os: "macOS" | "Windows" | "Linux";
  /** What a person picks by: "Apple silicon", "Intel", ".deb (Debian, Ubuntu)". */
  variant: string;
  contentType: string;
  /** Order on the page: macOS first, then Windows, then Linux. */
  rank: number;
}

interface Rule {
  test: RegExp;
  os: Installer["os"];
  variant: string;
  contentType: string;
  rank: number;
}

const RULES: Rule[] = [
  {
    test: /_aarch64\.dmg$/,
    os: "macOS",
    variant: "Apple silicon",
    contentType: "application/x-apple-diskimage",
    rank: 0,
  },
  {
    test: /_x64\.dmg$/,
    os: "macOS",
    variant: "Intel",
    contentType: "application/x-apple-diskimage",
    rank: 1,
  },
  {
    test: /_x64-setup\.exe$/,
    os: "Windows",
    variant: "Installer (.exe, current user)",
    contentType: "application/vnd.microsoft.portable-executable",
    rank: 2,
  },
  {
    test: /_x64_[a-z]{2}-[A-Z]{2}\.msi$/,
    os: "Windows",
    variant: "Installer (.msi)",
    contentType: "application/x-msi",
    rank: 3,
  },
  {
    test: /_amd64\.deb$/,
    os: "Linux",
    variant: ".deb (Debian, Ubuntu)",
    contentType: "application/vnd.debian.binary-package",
    rank: 4,
  },
  {
    test: /\.x86_64\.rpm$/,
    os: "Linux",
    variant: ".rpm (Fedora, RHEL)",
    contentType: "application/x-rpm",
    rank: 5,
  },
  {
    test: /_amd64\.AppImage$/,
    os: "Linux",
    variant: "AppImage (any distribution)",
    contentType: "application/x-executable",
    rank: 6,
  },
];

/**
 * The installer a build output is, or null for everything else a CI artifact
 * carries (sidecar binaries, `.sha256` files, `bundle_dmg.sh`, updater
 * `.sig`s). Only files whose name carries the expected version are accepted,
 * so a stale bundle left in `target/` from an older build cannot be published
 * under a new version's path.
 */
export function classifyInstaller(
  fileName: string,
  version: string,
): Installer | null {
  if (!fileName.startsWith("Oxagen")) return null;
  if (!fileName.includes(`_${version}_`) && !fileName.includes(`-${version}-`))
    return null;
  const rule = RULES.find((r) => r.test.test(fileName));
  if (rule === undefined) return null;
  return {
    file: fileName,
    os: rule.os,
    variant: rule.variant,
    contentType: rule.contentType,
    rank: rule.rank,
  };
}

/** Installers in page order, one per file name. */
export function sortInstallers<T extends Installer>(installers: T[]): T[] {
  const byName = new Map(installers.map((i) => [i.file, i]));
  return [...byName.values()].sort(
    (a, b) => a.rank - b.rank || a.file.localeCompare(b.file),
  );
}

/** `sha256sum` / `shasum -a 256` format, so `shasum -c` verifies it. */
export function sha256SumsText(
  entries: ReadonlyArray<{ file: string; sha256: string }>,
): string {
  return entries.map((e) => `${e.sha256}  ${e.file}`).join("\n") + "\n";
}

/** Bytes as a download page prints them: 81.9 MB. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface PageEntry extends Installer {
  bytes: number;
  sha256: string;
}

/**
 * The page at https://downloads.oxagen.sh/: one table per OS, each row a
 * link, its size and its SHA-256. Paper ground, Space Grotesk, gold only on
 * the wordmark's x — the house brand — with every style inline so the page
 * is one object and needs no other request.
 */
export function renderIndexHtml(input: {
  version: string;
  entries: PageEntry[];
  publishedAt: string;
}): string {
  const version = escapeHtml(input.version);
  const rows = (os: Installer["os"]) =>
    sortInstallers(input.entries)
      .filter((e) => e.os === os)
      .map((entry) => {
        const href = `desktop/${encodeURIComponent(input.version)}/${encodeURIComponent(entry.file)}`;
        return `<tr><td><a href="${href}">${escapeHtml(entry.variant)}</a><div class="f">${escapeHtml(entry.file)}</div></td><td class="n">${formatSize(entry.bytes)}</td><td class="h"><code>${escapeHtml(entry.sha256)}</code></td></tr>`;
      })
      .join("\n");
  const section = (os: Installer["os"], note: string) => {
    const body = rows(os);
    if (body === "") return "";
    return `<section><h2>${os}</h2><p class="note">${note}</p><div class="tw"><table><thead><tr><th>Download</th><th class="n">Size</th><th>SHA-256</th></tr></thead><tbody>
${body}
</tbody></table></div></section>`;
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download Oxagen</title>
<meta name="description" content="Oxagen desktop ${version}: installers for macOS, Windows and Linux.">
<style>
:root{--bg:#F2EEE5;--panel:#F8F5EE;--border:#D8CDBD;--text:#10100F;--body:#2A2823;--muted:#6B665C;--gold:#D6962C;--link:#8B5E1A;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);font:16px/1.55 "Space Grotesk","Helvetica Neue",Arial,sans-serif;padding-inline:20px;padding-block:28px 72px}
main{max-width:880px;margin:0 auto}
.wm{font-weight:600;font-size:24px;color:var(--text);letter-spacing:-.01em}.wm b{color:var(--gold);font-weight:600}
h1{font-size:32px;line-height:1.15;color:var(--text);margin:28px 0 8px;letter-spacing:-.02em}
h2{font-size:18px;color:var(--text);margin:32px 0 4px}
.lede{margin:0 0 4px;max-width:65ch}.note{color:var(--muted);margin:0 0 10px;font-size:14.5px;max-width:70ch}
.tw{overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:15px}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--border)}
th{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:500}
tr:last-child td{border-bottom:0}
a{color:var(--link);font-weight:500}a:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.f{color:var(--muted);font-size:13px}
.n{white-space:nowrap;font-variant-numeric:tabular-nums}
.h code{font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;word-break:break-all;color:var(--muted)}
footer{margin-top:36px;color:var(--muted);font-size:14px}
</style>
</head>
<body>
<main>
<div class="wm">o<b>x</b>agen</div>
<h1>Download Oxagen ${version}</h1>
<p class="lede">The Oxagen app signs a machine in to your organization and registers the Claude Code, Codex, and Stella installs it finds, so every run they make is recorded and governed.</p>
${section("macOS", "macOS 12 or newer. Open the .dmg and drag Oxagen to Applications before the first launch; while builds are unsigned, right-click the app and choose Open the first time.")}
${section("Windows", "Windows 10 or newer, x64. While builds are unsigned, SmartScreen asks once: More info, then Run anyway.")}
${section("Linux", "x86_64. Install the package for your distribution; the AppImage runs anywhere but must be installed or linked before registering agents.")}
<footer>Checksums for every file: <a href="desktop/${encodeURIComponent(input.version)}/SHA256SUMS.txt">SHA256SUMS.txt</a> (verify with <code>shasum -a 256 -c SHA256SUMS.txt</code>). Published ${escapeHtml(input.publishedAt)}.</footer>
</main>
</body>
</html>
`;
}

/**
 * What `aws` reported when asked whether a version is already published.
 *
 * `status` is `null` when the process never ran or was killed, which is why
 * it is kept separate from `spawnFailed` and `signal` rather than coerced to
 * a number: an exit code the CLI never produced must not be mistaken for one
 * it did.
 */
export interface PublicationProbe {
  status: number | null;
  signal: string | null;
  spawnFailed: boolean;
  /** Captured stdout — the `list-objects-v2` JSON, or "" for no keys. */
  stdout: string;
}

export type PublicationDecision =
  | { action: "publish" }
  | { action: "overwrite"; message: string }
  | { action: "stop"; code: number; message: string };

/**
 * How many objects the probe found, or `null` when its output cannot be read.
 *
 * `aws s3api list-objects-v2` answers with `KeyCount` and, when there is
 * anything to list, a `Contents` array; with the CLI's own pagination merging
 * pages it answers with `Contents` alone and prints nothing at all for a
 * prefix that holds nothing. All three are real answers, so both fields are
 * read and the larger wins. Anything else — output that is not JSON, a
 * `Contents` that is not an array, a `KeyCount` that is not a number — is no
 * answer at all and must not be rounded down to zero.
 */
export function countPublishedObjects(stdout: string): number | null {
  const text = stdout.trim();
  if (text === "") return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const listing = parsed as { Contents?: unknown; KeyCount?: unknown };
  let count = 0;
  if (listing.Contents !== undefined && listing.Contents !== null) {
    if (!Array.isArray(listing.Contents)) return null;
    count = listing.Contents.length;
  }
  if (listing.KeyCount !== undefined && listing.KeyCount !== null) {
    if (
      typeof listing.KeyCount !== "number" ||
      !Number.isFinite(listing.KeyCount)
    )
      return null;
    count = Math.max(count, listing.KeyCount);
  }
  return count;
}

/**
 * Whether to publish, overwrite or stop, given what the probe reported.
 *
 * Versioned download URLs are served `immutable, max-age=31536000`, a promise
 * to every cache downstream of CloudFront and not only to the edge, so a
 * republished version can stay wrong in a browser or a corporate proxy for
 * the rest of the year no matter what is invalidated. The only safe answers
 * are "this version is new" and "stop": every way of *not knowing* — the CLI
 * failing, being killed, or answering something unreadable — stops, because
 * reading a failed probe as "not published yet" would turn the one check
 * standing between a republish and a split fleet into a no-op exactly when it
 * is least safe to skip.
 */
export function decidePublication(
  probe: PublicationProbe,
  options: { version: string; prefix: string; allowOverwrite: boolean },
): PublicationDecision {
  const unknown = (why: string): PublicationDecision => ({
    action: "stop",
    code: 1,
    message:
      `✖ ${why}, so whether ${options.version} is already published is\n` +
      "  unknown; refusing rather than risk overwriting it.",
  });
  if (probe.spawnFailed) return unknown("aws could not be run");
  if (probe.signal !== null && probe.signal !== undefined)
    return unknown(`aws was killed by ${probe.signal}`);
  if (probe.status !== 0)
    return unknown(`aws s3api list-objects-v2 exited ${probe.status}`);
  const objects = countPublishedObjects(probe.stdout);
  if (objects === null)
    return unknown("aws printed a listing that is not JSON");
  if (objects === 0) return { action: "publish" };
  if (!options.allowOverwrite)
    return {
      action: "stop",
      code: 1,
      message:
        `✖ ${options.version} is already published at ${options.prefix}/.\n` +
        "  Those URLs were served as immutable, so caches downstream of\n" +
        "  CloudFront may hold the old installers for up to a year and no\n" +
        "  invalidation can reach them. Ship the fix as a new version.\n" +
        "  If nobody was ever given these URLs, re-run with --allow-overwrite.",
    };
  return {
    action: "overwrite",
    message:
      `! overwriting the published ${options.version}; only caches that never\n` +
      "  fetched these URLs will see the new installers",
  };
}

/**
 * The `aws s3api put-object` argv that reserves a version by writing its
 * checksum file.
 *
 * `--if-none-match "*"` is the whole point: S3 resolves the conditional write
 * atomically, so of two publishes of the same new version exactly one gets a
 * 2xx and the other a 412 — before either has uploaded an installer. Without
 * it, two invocations that both saw an empty prefix interleave their uploads
 * and can leave immutable installer URLs from one publish under a
 * SHA256SUMS.txt from the other. --allow-overwrite drops the condition,
 * because overwriting what is already there is exactly what that flag asks
 * for.
 */
export function reservationArgs(input: {
  bucket: string;
  key: string;
  body: string;
  cacheControl: string;
  allowOverwrite: boolean;
}): string[] {
  const args = [
    "s3api",
    "put-object",
    "--bucket",
    input.bucket,
    "--key",
    input.key,
    "--body",
    input.body,
    "--content-type",
    "text/plain; charset=utf-8",
    "--cache-control",
    input.cacheControl,
    "--no-cli-pager",
  ];
  if (!input.allowOverwrite) args.push("--if-none-match", "*");
  return args;
}
