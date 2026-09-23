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
 * The webfonts the page loads from `/fonts/` on the downloads host, copied
 * there by `scripts/publish-downloads.mjs` from `apps/web/fonts/` (the kit's
 * files, vendored by `tools/scripts/sync-brand-assets.mjs`). Three faces, one
 * job each: Space Grotesk for the headings, Geist for everything read, and
 * Monaspace Neon for file names, sizes, digests and the verify command.
 */
export const FONT_FILES = [
  "space-grotesk-latin-600.woff2",
  "space-grotesk-latin-700.woff2",
  "geist-latin-wght.woff2",
  "monaspace-neon-latin-wght.woff2",
] as const;

/** Where a version's release notes and its GitHub release live. */
export function releaseLinks(version: string): {
  notes: string;
  allReleases: string;
  githubRelease: string;
} {
  const v = encodeURIComponent(version);
  return {
    notes: `https://docs.oxagen.sh/docs/releases/v${v}`,
    allReleases: "https://docs.oxagen.sh/docs/releases",
    githubRelease: `https://github.com/macanderson/oxagen/releases/tag/desktop-v${v}`,
  };
}

/**
 * The oxagen lockup from the branding skill (`assets/logo.svg`): the hive,
 * a gap, the wordmark. The two lit cells and the x are gold and stay gold on
 * both grounds; everything else is `currentColor`. Inlined so the page stays
 * one object.
 */
const LOCKUP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 604.125 115.625" role="img" aria-label="oxagen" class="mark"><g transform="translate(21.575,22.616) scale(3.437130)"><g data-mark="hive"><path d="M0.000 -6.080L5.800 -3.040L5.800 3.040L0.000 6.080L-5.800 3.040L-5.800 -3.040Z" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="miter"/><path d="M13.080 -6.080L18.880 -3.040L18.880 3.040L13.080 6.080L7.280 3.040L7.280 -3.040Z" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="miter"/><path d="M6.540 4.160L12.340 7.200L12.340 13.280L6.540 16.320L0.740 13.280L0.740 7.200Z" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="miter"/><path d="M19.620 3.660L25.897 6.950L25.897 13.530L19.620 16.820L13.343 13.530L13.343 6.950Z" fill="#D4AF37"/><path d="M0.000 13.900L6.277 17.190L6.277 23.770L0.000 27.060L-6.277 23.770L-6.277 17.190Z" fill="#D4AF37" opacity="0.55"/><path d="M13.080 14.400L18.880 17.440L18.880 23.520L13.080 26.560L7.280 23.520L7.280 17.440Z" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="miter"/></g></g><g transform="translate(150.257,11.190)"><path class="letters" d="M33.9083 68.758Q24.1657 68.758 16.4786 64.7737Q8.79142 60.7894 4.39571 53.2965Q0 45.8035 0 35.3862V33.3718Q0 22.9544 4.39571 15.4615Q8.79142 7.96854 16.4786 3.98427Q24.1657 0 33.9083 0Q43.6509 0 51.3381 3.98427Q59.0252 7.96854 63.4209 15.4615Q67.8166 22.9544 67.8166 33.3718V35.3862Q67.8166 45.8035 63.4209 53.2965Q59.0252 60.7894 51.3381 64.7737Q43.6509 68.758 33.9083 68.758ZM33.9083 55.3486Q42.1895 55.3486 47.4689 50.0198Q52.7484 44.691 52.7484 35.0142V33.7437Q52.7484 24.067 47.5233 18.7382Q42.2981 13.4094 33.9083 13.4094Q25.6502 13.4094 20.3592 18.7382Q15.0683 24.067 15.0683 33.7437V35.0142Q15.0683 44.691 20.3592 50.0198Q25.6502 55.3486 33.9083 55.3486Z M176.569 68.758Q169.637 68.758 164.119 66.3453Q158.601 63.9327 155.387 59.2935Q152.173 54.6542 152.173 48.0088Q152.173 41.3403 155.387 36.8558Q158.601 32.3712 164.27 30.1017Q169.94 27.8323 177.174 27.8323H196.047V23.8925Q196.047 18.7316 192.874 15.5274Q189.701 12.3232 182.99 12.3232Q176.411 12.3232 173.049 15.3842Q169.686 18.4452 168.627 23.3593L154.691 18.7315Q156.27 13.6133 159.748 9.39702Q163.225 5.18071 169.049 2.59035Q174.874 0 183.208 0Q195.972 0 203.326 6.42816Q210.681 12.8563 210.681 24.9392V50.4707Q210.681 54.4204 214.368 54.4204H219.795V66.9148H209.197Q204.464 66.9148 201.442 64.5334Q198.42 62.1521 198.42 58.1563V57.8864H196.126Q195.392 59.6967 193.399 62.2985Q191.406 64.9004 187.388 66.8292Q183.369 68.758 176.569 68.758ZM179.05 56.4348Q186.581 56.4348 191.314 52.1592Q196.047 47.8837 196.047 40.6031V39.2405H178.175Q173.175 39.2405 170.208 41.3881Q167.241 43.5358 167.241 47.5513Q167.241 51.5668 170.34 54.0008Q173.439 56.4348 179.05 56.4348Z M227.767 34.6423V32.6279Q227.767 22.3817 231.86 15.0863Q235.953 7.79081 242.768 3.8954Q249.582 0 257.706 0Q266.935 0 271.762 3.33256Q276.589 6.66512 278.81 10.4107H281.042V1.8432H295.801V79.33Q295.801 85.6989 292.104 89.4725Q288.408 93.2462 282.079 93.2462H238.369V80.0541H277.023Q280.779 80.0541 280.779 76.1043V57.2775H278.547Q277.161 59.5683 274.665 61.8904Q272.168 64.2125 268.057 65.7414Q263.946 67.2702 257.706 67.2702Q249.582 67.2702 242.756 63.3748Q235.93 59.4794 231.848 52.1724Q227.767 44.8655 227.767 34.6423ZM261.938 54.0781Q270.151 54.0781 275.573 48.8612Q280.996 43.6443 280.996 34.2704V32.9999Q280.996 23.4943 275.627 18.3432Q270.259 13.1921 261.938 13.1921Q253.749 13.1921 248.315 18.3432Q242.881 23.4943 242.881 32.9999V34.2704Q242.881 43.6443 248.315 48.8612Q253.749 54.0781 261.938 54.0781Z M344.764 68.758Q334.998 68.758 327.583 64.6108Q320.167 60.4636 316.031 52.9048Q311.896 45.346 311.896 35.1689V33.589Q311.896 23.3889 315.977 15.8416Q320.059 8.2944 327.397 4.1472Q334.735 0 344.385 0Q353.881 0 360.956 4.1867Q368.031 8.37341 371.981 15.8515Q375.931 23.3297 375.931 33.2895V38.6974H327.181Q327.468 46.3334 332.587 50.9496Q337.707 55.5658 345.198 55.5658Q352.522 55.5658 356.101 52.3534Q359.681 49.141 361.553 45.0629L373.985 51.4813Q372.119 55.0656 368.63 59.1042Q365.141 63.1428 359.394 65.9504Q353.648 68.758 344.764 68.758ZM327.313 27.2892H360.622Q360.095 20.7986 355.7 16.9954Q351.304 13.1921 344.277 13.1921Q337.055 13.1921 332.691 16.9954Q328.327 20.7986 327.313 27.2892Z M391.548 66.9148V1.8432H406.353V10.9769H408.585Q410.303 7.25429 414.832 3.99908Q419.361 0.743866 428.435 0.743866Q435.956 0.743866 441.695 4.12911Q447.434 7.51435 450.651 13.5903Q453.868 19.6663 453.868 27.9442V66.9148H438.8V29.1226Q438.8 21.1969 434.891 17.3492Q430.983 13.5015 423.9 13.5015Q415.872 13.5015 411.244 18.8237Q406.617 24.146 406.617 33.9445V66.9148Z" fill="currentColor"/><path class="accent" d="M73.9979 66.9148 98.2261 34.0696 74.3764 1.8432H91.9626L107.9 24.3499H110.131L126.068 1.8432H143.654L119.805 34.0696L144.033 66.9148H126.206L110.131 44.0065H107.9L91.8244 66.9148Z" fill="#D4AF37"/></g></svg>`;

/**
 * The page at https://downloads.oxagen.sh/. House brand: obsidian first with
 * the white theme on `prefers-color-scheme: light` or `data-theme="light"`,
 * the three faces, the 12px radius, the 1120px wrap. Gold appears on the mark
 * and on one action, the download button for the visitor's own OS, which a
 * few lines of script pick from the user agent; without script it offers the
 * first installer and the tables below cover the rest. Every style is inline
 * so the page is one object; the fonts are the only other requests.
 */
export function renderIndexHtml(input: {
  version: string;
  entries: PageEntry[];
  publishedAt: string;
  /**
   * Whether the `desktop-v<version>` GitHub release with the bare `tacho`
   * and `oxagen` executables exists. False for a version published before
   * the release workflow attached them (2.1.1), so the page does not send a
   * reader to a 404. Default true: a tagged build always has one.
   */
  cliRelease?: boolean;
}): string {
  const version = escapeHtml(input.version);
  const sorted = sortInstallers(input.entries);
  const links = releaseLinks(input.version);
  const hrefOf = (file: string) =>
    `desktop/${encodeURIComponent(input.version)}/${encodeURIComponent(file)}`;
  const rows = (os: Installer["os"]) =>
    sorted
      .filter((e) => e.os === os)
      .map(
        (entry) =>
          `<li><div class="row"><a href="${hrefOf(entry.file)}">${escapeHtml(entry.variant)}</a><span class="num">${formatSize(entry.bytes)}</span></div><div class="file">${escapeHtml(entry.file)}</div><div class="sum"><span>SHA-256</span><code>${escapeHtml(entry.sha256)}</code></div></li>`,
      )
      .join("\n");
  const section = (os: Installer["os"], note: string) => {
    const body = rows(os);
    if (body === "") return "";
    return `<section class="panel" id="${os.toLowerCase()}"><h2>${os}</h2><p class="note">${note}</p><ul class="list">
${body}
</ul></section>`;
  };
  // The one action. The script below swaps it for the visitor's OS; this is
  // the no-script answer and the first row of the first table.
  const first = sorted[0];
  const primary =
    first === undefined
      ? ""
      : `<a class="btn" id="pick" href="${hrefOf(first.file)}" data-os="${first.os}">Download for ${first.os} (${escapeHtml(first.variant)})</a>`;
  // What the script may pick per OS: the installer most machines want. A
  // Mac's architecture is not in the user agent (Safari on Apple silicon
  // says Intel), so macOS gets both: the script asks Chromium's high-entropy
  // hints when they exist and otherwise offers Apple silicon with the Intel
  // build one click away beside it, never as a second gold action.
  const preferred: ReadonlyArray<[string, Installer["os"], RegExp]> = [
    ["macOS", "macOS", /_aarch64\.dmg$/],
    ["macOSIntel", "macOS", /_x64\.dmg$/],
    ["Windows", "Windows", /_x64-setup\.exe$/],
    ["Linux", "Linux", /_amd64\.AppImage$/],
  ];
  const picks: Record<string, { href: string; label: string }> = {};
  for (const [key, os, re] of preferred) {
    const entry = sorted.find((e) => e.os === os && re.test(e.file));
    if (entry !== undefined)
      picks[key] = {
        href: hrefOf(entry.file),
        label: `${os} (${entry.variant})`,
      };
  }
  const picksJson = JSON.stringify(picks);
  const fontFaces = [
    ["Space Grotesk", "space-grotesk-latin-600.woff2", "600"],
    ["Space Grotesk", "space-grotesk-latin-700.woff2", "700"],
    ["Geist", "geist-latin-wght.woff2", "100 900"],
    ["Monaspace Neon", "monaspace-neon-latin-wght.woff2", "200 800"],
  ]
    .map(
      ([family, file, weight]) =>
        `@font-face{font-family:"${family}";src:url("fonts/${file}") format("woff2");font-weight:${weight};font-style:normal;font-display:swap}`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download Oxagen</title>
<meta name="description" content="Oxagen ${version} for macOS, Windows, and Linux, with a SHA-256 for every file.">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-7 -17 27 34'%3E%3Cpath d='M6.54 4.16l5.8 3.04v6.08l-5.8 3.04-5.8-3.04V7.2z' fill='%23D4AF37'/%3E%3Cpath d='M6.54-16.32l5.8 3.04v6.08l-5.8 3.04-5.8-3.04v-6.08z' fill='%23D4AF37'/%3E%3C/svg%3E">
<style>
${fontFaces}
:root{--ink:#09090B;--panel:#18181B;--hl:#27272A;--border:#27272A;--rule:#3F3F46;--fg:#FFFFFF;--body:#E4E4E7;--muted:#A1A1AA;--dim:#71717A;--gold:#D4AF37;--gold-deep:#8A7223;--accent-text:#D4AF37;--on-gold:#09090B;--font-display:"Space Grotesk","Helvetica Neue",Arial,sans-serif;--font:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"Monaspace Neon",ui-monospace,"SF Mono",Menlo,Consolas,monospace;--radius:12px;--wrap:1120px;color-scheme:dark}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--ink:#FFFFFF;--panel:#FFFFFF;--hl:#F4F4F5;--border:#E4E4E7;--rule:#D4D4D8;--fg:#09090B;--body:#27272A;--muted:#71717A;--dim:#A1A1AA;--accent-text:#8A7223;color-scheme:light}}
:root[data-theme="light"]{--ink:#FFFFFF;--panel:#FFFFFF;--hl:#F4F4F5;--border:#E4E4E7;--rule:#D4D4D8;--fg:#09090B;--body:#27272A;--muted:#71717A;--dim:#A1A1AA;--accent-text:#8A7223;color-scheme:light}
*{box-sizing:border-box}
html{background:var(--ink)}
body{margin:0;background:var(--ink);color:var(--body);font:16px/1.55 var(--font);-webkit-font-smoothing:antialiased}
code,.file,.num,.tag,.sum code{font-family:var(--mono);font-feature-settings:"calt","liga"}
a{color:var(--fg);text-decoration:underline;text-decoration-color:var(--rule);text-underline-offset:3px}
a:hover{text-decoration-color:var(--fg)}
:focus-visible{outline:2px solid var(--gold);outline-offset:3px;border-radius:4px}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 24px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 0;border-bottom:1px solid var(--border)}
header a{text-decoration:none;color:var(--fg);display:inline-flex}
.mark{height:26px;width:auto;display:block}
.tag{font-size:12px;color:var(--muted);letter-spacing:.02em}
.hero{padding:44px 0 36px;border-bottom:1px solid var(--border)}
.eyebrow{font:500 12px/1.4 var(--font);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
h1{font:700 40px/1.15 var(--font-display);letter-spacing:-.02em;color:var(--fg);margin:0 0 14px}
h2{font:600 20px/1.25 var(--font-display);color:var(--fg);margin:0 0 6px}
.lede{margin:0;max-width:64ch;font-size:18px;line-height:1.6}
.meta{margin:18px 0 0;color:var(--muted);font-size:14px;display:flex;flex-wrap:wrap;gap:6px 18px}
.meta code{font-size:13px;color:var(--fg)}
.cta{display:flex;flex-wrap:wrap;align-items:center;gap:14px 20px;margin-top:26px}
.btn{display:inline-flex;align-items:center;gap:10px;background:var(--gold);color:var(--on-gold);font:600 15px/1 var(--font);padding:14px 20px;border-radius:8px;text-decoration:none;border:1px solid var(--gold)}
.btn:hover{background:#F1CE65;border-color:#F1CE65}
.cta .alt{color:var(--muted);font-size:14px}
.cta .alt a{color:var(--fg)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;padding:36px 0}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:20px 20px 12px;min-width:0}
.panel[aria-current="true"]{border:3px double var(--rule)}
.note{color:var(--muted);margin:0 0 14px;font-size:14px;line-height:1.5}
.list{list-style:none;margin:0;padding:0;border-top:1px solid var(--border)}
.list li{padding:12px 0;border-bottom:1px solid var(--border)}
.list li:last-child{border-bottom:0;padding-bottom:4px}
.row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.row a{font-weight:500}
.file{color:var(--muted);font-size:12px;margin-top:4px;word-break:break-all}
.num{white-space:nowrap;font-variant-numeric:tabular-nums;font-size:13px;color:var(--muted)}
.sum{display:flex;gap:8px;align-items:baseline;margin-top:6px;font-size:11px;line-height:1.45}
.sum span{color:var(--dim);font:500 10px/1.45 var(--font);letter-spacing:.08em;text-transform:uppercase;flex:none}
.sum code{color:var(--muted);word-break:break-all}
.verify{border-top:1px solid var(--border);padding:32px 0 20px;display:grid;gap:22px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.verify h2{margin-bottom:8px}
.verify p{margin:0 0 10px;font-size:15px}
pre{margin:0;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 14px;overflow-x:auto;font:13px/1.5 var(--mono);color:var(--fg)}
footer{border-top:1px solid var(--border);padding:22px 0 56px;color:var(--muted);font-size:14px;display:flex;flex-wrap:wrap;gap:8px 24px}
footer a{color:var(--muted)}
@media (max-width:640px){h1{font-size:32px}.hero{padding:32px 0 28px}.grid{padding:24px 0}}
</style>
</head>
<body>
<div class="wrap">
<header><a href="https://oxagen.sh/" aria-label="oxagen">${LOCKUP_SVG}</a><span class="tag">downloads.oxagen.sh</span></header>
<section class="hero">
<p class="eyebrow">Workforce management for autonomous agents</p>
<h1>Download the Oxagen app</h1>
<p class="lede">The Oxagen app signs this machine in to your organization and registers the Claude Code, Codex, Cursor, and Stella installs it finds. Every run they make is recorded, and every action routed through Oxagen is answered by your rules.</p>
<p class="meta"><span>Version <code>${version}</code></span><span>Published <code>${escapeHtml(input.publishedAt)}</code></span><span><a href="${links.notes}">Release notes</a></span></p>
<div class="cta">${primary}<span class="alt" id="alt">Other platforms and architectures are listed below. Each file has a SHA-256.</span></div>
</section>
<div class="grid">
${section("macOS", "macOS 12 or newer. Open the .dmg and drag Oxagen to Applications. Builds are not yet notarized, so the first launch is a right-click, then Open.")}
${section("Windows", "Windows 10 or newer, x64. Builds are not yet signed, so SmartScreen asks once: More info, then Run anyway.")}
${section("Linux", "x86_64. Install the package for your distribution. The AppImage runs anywhere once it is executable.")}
</div>
<section class="verify">
<div><h2>Verify a download</h2><p>Every file in this version is listed in <a href="desktop/${encodeURIComponent(input.version)}/SHA256SUMS.txt">SHA256SUMS.txt</a>. Put it beside the file you downloaded and run:</p><pre>shasum -a 256 -c SHA256SUMS.txt</pre></div>
<div><h2>Command line only</h2><p>The <code>tacho</code> and <code>oxagen</code> executables ship inside the app and link onto your PATH on first launch.${
    input.cliRelease === false
      ? ""
      : ` To install them without the app, take the bare binaries from the <a href="${links.githubRelease}">GitHub release</a> for ${version}.`
  }</p></div>
</section>
<footer><a href="${links.notes}">What changed in ${version}</a><a href="${links.allReleases}">All releases</a><a href="https://docs.oxagen.sh/docs/cli/desktop">App guide</a><a href="https://oxagen.sh/">oxagen.sh</a></footer>
</div>
<script>
(function(){var picks=${picksJson};var el=document.getElementById("pick");var alt=document.getElementById("alt");if(!el)return;var ua=navigator.userAgent||"";var uad=navigator.userAgentData;var p=(uad&&uad.platform)||navigator.platform||"";var os=/Win/i.test(p)||/Windows/i.test(ua)?"Windows":/Mac/i.test(p)||/Mac OS/i.test(ua)?"macOS":/Linux|X11/i.test(p+ua)?"Linux":null;if(!os)return;function apply(key,note){var pick=picks[key];if(!pick)return;el.href=pick.href;el.textContent="Download for "+pick.label;el.setAttribute("data-os",os);var panel=document.getElementById(os.toLowerCase());if(panel)panel.setAttribute("aria-current","true");if(alt&&note)alt.innerHTML=note;}
if(os!=="macOS"){apply(os);return;}
var intel=picks.macOSIntel;var intelNote=intel?'On an Intel Mac? <a href="'+intel.href+'">Download the Intel build</a>. Each file has a SHA-256.':"";
apply("macOS",intelNote);
if(uad&&uad.getHighEntropyValues){uad.getHighEntropyValues(["architecture"]).then(function(h){if(h&&/^(x86|x64)/i.test(h.architecture||""))apply("macOSIntel","Apple silicon? The macOS panel below has that build. Each file has a SHA-256.");}).catch(function(){});}})();
</script>
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
  | {
      action: "stop";
      code: number;
      message: string;
      /** `published`: the version is there. `unknown`: the probe could not say. */
      reason: "published" | "unknown";
    };

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
    reason: "unknown",
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
      reason: "published",
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

/** What the caller should print, and whether it should then stop. */
export interface PublicationReport {
  /** `null` when there is nothing to say. */
  message: string | null;
  /** Which stream the message belongs on. */
  level: "error" | "warn" | null;
  /** `null` means carry on; a number is the status to exit with. */
  exitCode: number | null;
}

/**
 * Turn a decision into what to print and whether to stop, given `--dry-run`.
 *
 * A dry run writes nothing — every upload is printed rather than performed —
 * so the reason the probe exists does not apply to it: there is no republish
 * to stop and no fleet to split. A preview that demands working credentials,
 * or that refuses to show the plan for a version already published, is not a
 * preview. So a dry run never exits on a stop. It still says what the real
 * run would have decided, because someone previewing a version that is
 * already published should be told, and someone whose session has expired
 * should know the preview could not check — neither is a reason to withhold
 * the plan.
 *
 * The leniency lives here and only here. `decidePublication` keeps its three
 * outcomes, so the path that actually writes to S3 is decided by the same
 * function whether or not this one is in the picture, and there is no second
 * route to an upload.
 */
export function reportPublicationDecision(
  decision: PublicationDecision,
  options: { dryRun: boolean },
): PublicationReport {
  if (decision.action === "publish")
    return { message: null, level: null, exitCode: null };
  if (decision.action === "overwrite")
    return { message: decision.message, level: "warn", exitCode: null };
  if (!options.dryRun)
    return {
      message: decision.message,
      level: "error",
      exitCode: decision.code,
    };
  return {
    // Re-marked from ✖ to !, because the line that follows says this is not a
    // refusal and the first character should not have to be taken back.
    message:
      `${decision.message.replace(/^✖ /, "! ")}\n` +
      "  A dry run writes nothing, so this is a warning and not a refusal;\n" +
      "  the planned uploads follow. A real publish would stop here.",
    level: "warn",
    exitCode: null,
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

/**
 * How `curl` downloads one run artifact: the argv, and a config text for the
 * script to write to curl's stdin.
 *
 * The GitHub token goes in the config text (`--config -`), never on the argv.
 * Every local process can read another's argv from `ps` or
 * `/proc/<pid>/cmdline` for as long as the download runs, which for the
 * ~190 MB Windows artifact is minutes. A pipe is readable only by the two
 * processes on its ends.
 *
 * The token is written as a quoted config value, where curl reads a backslash
 * as an escape, so backslashes and quotes are escaped. A token holding a line
 * break or another control character is refused: it would end the config line
 * and let whatever follows it be read as a curl option.
 */
export function artifactDownloadCurl(input: {
  token: string;
  url: string;
  output: string;
}): { args: string[]; config: string } {
  if (input.token === "")
    throw new Error("the GitHub token is empty; run `gh auth login`");
  const hasControl = [...input.token].some((c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (hasControl) throw new Error("the GitHub token holds a control character");
  const quoted = input.token.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return {
    args: [
      "-sSL",
      "--retry",
      "5",
      "--retry-all-errors",
      "--retry-delay",
      "10",
      "--config",
      "-",
      "-o",
      input.output,
      input.url,
    ],
    config: `header = "Authorization: Bearer ${quoted}"\n`,
  };
}

/**
 * The temporary directories a publish has made, removed together on exit.
 *
 * The script stops in many places: `process.exit` after a refusal, a child
 * process that failed, an uncaught error, or a signal. Removing each
 * directory at the end of the happy path left one behind on every other
 * path, holding up to ~500 MB of unzipped installers. The script instead
 * registers `cleanup` once on the process `exit` event, which Node emits for
 * `process.exit` and for an uncaught error alike, and turns SIGINT, SIGTERM
 * and SIGHUP into a `process.exit` so they reach it too.
 *
 * `remove` is injected so the tracker stays pure for the unit tests. A
 * failed removal is reported through `onError` and does not stop the rest
 * being removed.
 */
export function tempDirTracker(
  remove: (path: string) => void,
  onError: (path: string, error: unknown) => void = () => {},
): {
  track: (path: string) => string;
  cleanup: () => void;
  tracked: () => string[];
} {
  const dirs = new Set<string>();
  return {
    track(path) {
      dirs.add(path);
      return path;
    },
    cleanup() {
      for (const path of [...dirs]) {
        dirs.delete(path);
        try {
          remove(path);
        } catch (error) {
          onError(path, error);
        }
      }
    },
    tracked: () => [...dirs],
  };
}
