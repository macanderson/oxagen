import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  advancesLatest,
  classifyInstaller,
  compareVersions,
  countPublishedObjects,
  isBuildVersion,
  LATEST_CACHE_CONTROL,
  latestCopyArgs,
  latestManifest,
  readLatestVersion,
  decidePublication,
  FONT_FILES,
  formatSize,
  type PageEntry,
  type PublicationProbe,
  releaseLinks,
  renderIndexHtml,
  reportPublicationDecision,
  reservationArgs,
  sha256SumsText,
  sortInstallers,
} from "./downloads";

const V = "2.1.1";
const FILES = [
  "Oxagen_2.1.1_aarch64.dmg",
  "Oxagen_2.1.1_x64.dmg",
  "Oxagen_2.1.1_x64-setup.exe",
  "Oxagen_2.1.1_x64_en-US.msi",
  "Oxagen_2.1.1_amd64.deb",
  "Oxagen-2.1.1-1.x86_64.rpm",
  "Oxagen_2.1.1_amd64.AppImage",
];

describe("classifyInstaller", () => {
  it("recognises every installer the desktop workflow builds", () => {
    const got = FILES.map((f) => classifyInstaller(f, V));
    expect(got.map((i) => [i?.os, i?.variant])).toEqual([
      ["macOS", "Apple silicon"],
      ["macOS", "Intel"],
      ["Windows", "Installer (.exe, current user)"],
      ["Windows", "Installer (.msi)"],
      ["Linux", ".deb (Debian, Ubuntu)"],
      ["Linux", ".rpm (Fedora, RHEL)"],
      ["Linux", "AppImage (any distribution)"],
    ]);
    expect(classifyInstaller("Oxagen_2.1.1_aarch64.dmg", V)?.contentType).toBe(
      "application/x-apple-diskimage",
    );
  });

  it("ignores everything else an artifact carries, and other versions", () => {
    for (const other of [
      "Oxagen_2.1.1_aarch64.dmg.sha256",
      "bundle_dmg.sh",
      "tacho-aarch64-apple-darwin",
      "oxagen-x86_64-pc-windows-msvc.exe",
      "Oxagen.app.tar.gz.sig",
      "icon.icns",
    ]) {
      expect(classifyInstaller(other, V)).toBeNull();
    }
    // A stale bundle from an older build must not ship under a new path.
    expect(classifyInstaller("Oxagen_2.1.0_aarch64.dmg", V)).toBeNull();
    expect(classifyInstaller("Oxagen-2.1.0-1.x86_64.rpm", V)).toBeNull();
  });
});

describe("builds of main", () => {
  const B = "2.1.2-37";
  const BUILD_FILES = [
    `Oxagen_${B}_aarch64.dmg`,
    `Oxagen_${B}_x64.dmg`,
    `Oxagen_${B}_x64-setup.exe`,
    `Oxagen_${B}_x64_en-US.msi`,
    `Oxagen_${B}_amd64.deb`,
    `Oxagen-${B}-1.x86_64.rpm`,
    `Oxagen_${B}_amd64.AppImage`,
  ];

  it("classifies a build's installers like a release's", () => {
    expect(BUILD_FILES.map((f) => classifyInstaller(f, B)?.latest)).toEqual([
      "Oxagen_aarch64.dmg",
      "Oxagen_x64.dmg",
      "Oxagen_x64-setup.exe",
      "Oxagen_x64_en-US.msi",
      "Oxagen_amd64.deb",
      "Oxagen.x86_64.rpm",
      "Oxagen_amd64.AppImage",
    ]);
    // The release a build precedes is a different version.
    expect(classifyInstaller("Oxagen_2.1.2_aarch64.dmg", B)).toBeNull();
  });

  it("tells a build from a release", () => {
    expect(isBuildVersion(B)).toBe(true);
    expect(isBuildVersion("2.1.2")).toBe(false);
    expect(isBuildVersion("2.1.2-rc.1")).toBe(false);
  });

  it("orders builds before the release they lead to", () => {
    const ordered = [
      "2.1.1",
      "2.1.2-4",
      "2.1.2-9",
      "2.1.2-10",
      "2.1.2",
      "2.2.0-1",
    ];
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(compareVersions)).toEqual(ordered);
    expect(compareVersions("2.1.2-4", "2.1.2-4")).toBe(0);
    expect(() => compareVersions("2.1.2-rc.1", "2.1.2")).toThrow(
      /not a version/,
    );
  });

  it("only moves latest forward", () => {
    expect(advancesLatest(null, "2.1.1")).toBe(true);
    expect(advancesLatest("2.1.1", "2.1.2-1")).toBe(true);
    expect(advancesLatest("2.1.2-5", "2.1.2")).toBe(true);
    expect(advancesLatest("2.1.2-5", "2.1.2-5")).toBe(true);
    expect(advancesLatest("2.1.2-5", "2.1.2-4")).toBe(false);
    expect(advancesLatest("2.1.3-1", "2.1.2")).toBe(false);
  });

  it("reads latest.json defensively", () => {
    expect(readLatestVersion(null)).toBeNull();
    expect(readLatestVersion("")).toBeNull();
    expect(readLatestVersion("not json")).toBeNull();
    expect(readLatestVersion('{"version":7}')).toBeNull();
    expect(readLatestVersion('{"version":"2.1.2-3"}')).toBe("2.1.2-3");
  });

  it("describes a build in latest.json and copies it under its stable name", () => {
    const entries: PageEntry[] = BUILD_FILES.map((f) => ({
      ...classifyInstaller(f, B)!,
      bytes: 10,
      sha256: "0".repeat(64),
    }));
    const manifest = latestManifest({
      version: B,
      publishedAt: "2026-09-24",
      entries,
      host: "downloads.oxagen.sh",
    });
    expect(manifest.channel).toBe("build");
    expect(manifest.checksums).toBe(
      `https://downloads.oxagen.sh/desktop/${B}/SHA256SUMS.txt`,
    );
    expect(manifest.installers.map((i) => i.latestUrl)).toContain(
      "https://downloads.oxagen.sh/latest/Oxagen_x64-setup.exe",
    );
    expect(manifest.installers[0]?.url).toBe(
      `https://downloads.oxagen.sh/desktop/${B}/Oxagen_${B}_aarch64.dmg`,
    );
    const args = latestCopyArgs({
      bucket: "b",
      version: B,
      entry: entries[0]!,
    });
    expect(args.slice(0, 4)).toEqual([
      "s3",
      "cp",
      `s3://b/desktop/${B}/Oxagen_${B}_aarch64.dmg`,
      "s3://b/latest/Oxagen_aarch64.dmg",
    ]);
    expect(args).toContain("REPLACE");
    expect(args).toContain(`attachment; filename="Oxagen_${B}_aarch64.dmg"`);
    expect(args).toContain(LATEST_CACHE_CONTROL);
    expect(LATEST_CACHE_CONTROL).not.toContain("immutable");
  });

  it("renders a build's page without a notes page or GitHub release it does not have", () => {
    const html = renderIndexHtml({
      version: B,
      entries: [
        { ...classifyInstaller(BUILD_FILES[0]!, B)!, bytes: 1, sha256: "a" },
      ],
      publishedAt: "2026-09-24",
    });
    expect(html).toContain(`Build <code>${B}</code>`);
    expect(html).not.toContain(`releases/v${B}`);
    expect(html).not.toContain(`desktop-v${B}`);
    expect(releaseLinks(B).notes).toBe("https://docs.oxagen.sh/docs/releases");
  });
});

describe("the version-free names", () => {
  // The web app and the docs link these names without importing this file,
  // so a rename here must reach both. This reads their tables as text.
  it("are the ones the web app and the docs link", () => {
    const names = FILES.map((f) => classifyInstaller(f, V)!.latest);
    for (const consumer of [
      "../../app/src/shared/desktop-downloads.ts",
      "../../docs/src/components/mdx/latest-downloads.tsx",
    ]) {
      const text = readFileSync(new URL(consumer, import.meta.url), "utf8");
      for (const name of names) expect(text, consumer).toContain(`"${name}"`);
    }
  });

  // The docs tables carry their own macOS note, so the first-launch steps
  // must reach them too, and the removed Control-click route must not.
  it("carry the macOS first-launch steps in both docs tables", () => {
    for (const consumer of [
      "../../docs/src/components/mdx/latest-downloads.tsx",
      "../../docs/src/components/mdx/release-downloads.tsx",
    ]) {
      const text = readFileSync(new URL(consumer, import.meta.url), "utf8");
      expect(text, consumer).toContain(
        "Choose Done, then click Open Anyway in System Settings > Privacy & Security.",
      );
      expect(text, consumer).not.toMatch(/(right|control|ctrl)[- ]click/i);
    }
  });
});

describe("check-latest.mjs", () => {
  const check = (latest: string, version: string) => {
    const dir = mkdtempSync(join(tmpdir(), "downloads-latest-test-"));
    try {
      writeFileSync(join(dir, "latest.json"), latest);
      return spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../scripts/check-latest.mjs", import.meta.url),
          ),
          join(dir, "latest.json"),
          version,
        ],
        { encoding: "utf8" },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("passes on this version or a newer one and fails on an older one", () => {
    expect(check('{"version":"2.1.2-5"}', "2.1.2-5").status).toBe(0);
    expect(check('{"version":"2.1.2-5"}', "2.1.2-4").status).toBe(0);
    const older = check('{"version":"2.1.2-5"}', "2.1.2");
    expect(older.status).toBe(1);
    expect(older.stderr).toContain("older than 2.1.2");
    expect(check("<html>not found</html>", "2.1.2").status).toBe(1);
  });
});

describe("page helpers", () => {
  it("orders macOS, Windows, Linux and drops duplicate file names", () => {
    const shuffled = [...FILES].reverse().map((f) => classifyInstaller(f, V)!);
    const sorted = sortInstallers([...shuffled, shuffled[0]!]);
    expect(sorted.map((i) => i.file)).toEqual(FILES);
  });

  it("writes SHA256SUMS in the format shasum -c reads", () => {
    expect(
      sha256SumsText([
        { file: "a.dmg", sha256: "ab" },
        { file: "b.msi", sha256: "cd" },
      ]),
    ).toBe("ab  a.dmg\ncd  b.msi\n");
  });

  it("formats sizes", () => {
    expect(formatSize(81_875_708)).toBe("78.1 MB");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(10)).toBe("1 KB");
    expect(formatSize(-1)).toBe("?");
    expect(formatSize(Number.NaN)).toBe("?");
  });

  it("renders one linked row per installer under its OS, with size and checksum", () => {
    const entries: PageEntry[] = FILES.map((f, i) => ({
      ...classifyInstaller(f, V)!,
      bytes: 50_000_000 + i,
      sha256: `${i}`.padStart(64, "0"),
    }));
    const html = renderIndexHtml({
      version: V,
      entries,
      publishedAt: "2026-09-15",
    });
    expect(html).toContain("<title>Download Oxagen</title>");
    for (const f of FILES) {
      expect(html).toContain(`href="desktop/2.1.1/${encodeURIComponent(f)}"`);
    }
    const mac = html.indexOf("<h2>macOS</h2>");
    const win = html.indexOf("<h2>Windows</h2>");
    const linux = html.indexOf("<h2>Linux</h2>");
    expect(mac).toBeGreaterThan(0);
    expect(win).toBeGreaterThan(mac);
    expect(linux).toBeGreaterThan(win);
    expect(html).toContain('href="desktop/2.1.1/SHA256SUMS.txt"');
    expect(html).toContain("47.7 MB");
    expect(html).toContain(`${"3".padStart(64, "0")}</code>`);
    // An OS with nothing published gets no empty panel.
    const macOnly = renderIndexHtml({
      version: V,
      entries: entries.slice(0, 2),
      publishedAt: "x",
    });
    expect(macOnly).not.toContain("<h2>Windows</h2>");
    // Nothing a file name carries can inject markup.
    const hostile = renderIndexHtml({
      version: '2"<b>',
      entries: [],
      publishedAt: "<script>",
    });
    // The page carries one <script> of its own; the hostile date is not it.
    expect(hostile.match(/<script>/g)).toHaveLength(1);
    expect(hostile).toContain("Published <code>&lt;script&gt;</code>");
    expect(hostile).toContain("2&quot;&lt;b&gt;");
  });

  it("offers one gold action, picked per OS by the script and the first installer without it", () => {
    const entries: PageEntry[] = FILES.map((f) => ({
      ...classifyInstaller(f, V)!,
      bytes: 1,
      sha256: "0".repeat(64),
    }));
    const html = renderIndexHtml({ version: V, entries, publishedAt: "d" });
    // The no-script answer is the first row of the first panel.
    expect(html).toContain(
      '<a class="btn" id="pick" href="desktop/2.1.1/Oxagen_2.1.1_aarch64.dmg" data-os="macOS">Download for macOS (Apple silicon)</a>',
    );
    // The script chooses the installer most machines want on each OS.
    expect(html).toContain(
      '"Windows":{"href":"desktop/2.1.1/Oxagen_2.1.1_x64-setup.exe"',
    );
    expect(html).toContain(
      '"Linux":{"href":"desktop/2.1.1/Oxagen_2.1.1_amd64.AppImage"',
    );
    // Exactly one gold-filled action on the page.
    expect(html.match(/class="btn"/g)).toHaveLength(1);
    // Both themes ship: obsidian by default, white on the OS preference.
    expect(html).toContain("prefers-color-scheme: light");
    expect(html).toContain('<meta name="color-scheme" content="dark light">');
    // The three faces, loaded from the host's own /fonts/.
    for (const file of FONT_FILES) expect(html).toContain(`fonts/${file}`);
    // No em dash reaches a reader.
    expect(html).not.toContain("\u2014");
    // A version with no installers at all still renders without an action.
    const empty = renderIndexHtml({
      version: V,
      entries: [],
      publishedAt: "d",
    });
    expect(empty).not.toContain('id="pick"');
  });

  it("gives macOS the first-launch steps that still work on macOS 15", () => {
    const entries: PageEntry[] = FILES.map((f) => ({
      ...classifyInstaller(f, V)!,
      bytes: 1,
      sha256: "0".repeat(64),
    }));
    const html = renderIndexHtml({ version: V, entries, publishedAt: "d" });
    expect(html).toContain('<div id="macos-first-launch">');
    expect(html).toContain('href="#macos-first-launch"');
    expect(html).toContain("Open Anyway");
    expect(html).toContain(
      "<pre>xattr -dr com.apple.quarantine /Applications/Oxagen.app</pre>",
    );
    // macOS 15 removed the Control-click Open override, so the page must not
    // send anyone looking for it.
    expect(html).not.toMatch(/(right|control|ctrl)[- ]click/i);
    // A version with no macOS build carries no macOS steps.
    const noMac = renderIndexHtml({
      version: V,
      entries: entries.filter((e) => e.os !== "macOS"),
      publishedAt: "d",
    });
    expect(noMac).not.toContain("macos-first-launch");
  });

  it("links an App guide page the docs site carries", () => {
    const html = renderIndexHtml({ version: V, entries: [], publishedAt: "d" });
    expect(html).toContain(
      '<a href="https://docs.oxagen.sh/docs/cli/desktop">App guide</a>',
    );
    const page = readFileSync(
      fileURLToPath(
        new URL("../../docs/content/docs/cli/desktop.mdx", import.meta.url),
      ),
      "utf8",
    );
    expect(page).toContain("## First launch on macOS");
    const nav = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../docs/content/docs/cli/meta.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as { pages: string[] };
    expect(nav.pages).toContain("desktop");
  });

  it("links every version to its release notes and its GitHub release", () => {
    expect(releaseLinks("2.1.1")).toEqual({
      notes: "https://docs.oxagen.sh/docs/releases/v2.1.1",
      allReleases: "https://docs.oxagen.sh/docs/releases",
      githubRelease:
        "https://github.com/macanderson/oxagen/releases/tag/desktop-v2.1.1",
    });
    expect(releaseLinks("2 1").notes).toBe(
      "https://docs.oxagen.sh/docs/releases/v2%201",
    );
    const html = renderIndexHtml({
      version: "2.1.1",
      entries: [],
      publishedAt: "d",
    });
    expect(html).toContain(
      'href="https://docs.oxagen.sh/docs/releases/v2.1.1"',
    );
    expect(html).toContain(
      'href="https://github.com/macanderson/oxagen/releases/tag/desktop-v2.1.1"',
    );
  });
});

const OK: PublicationProbe = {
  status: 0,
  signal: null,
  spawnFailed: false,
  stdout: "",
};
const OPTS = {
  version: V,
  prefix: `s3://bucket/desktop/${V}`,
  allowOverwrite: false,
};
const decide = (probe: Partial<PublicationProbe>, allowOverwrite = false) =>
  decidePublication({ ...OK, ...probe }, { ...OPTS, allowOverwrite });

describe("countPublishedObjects", () => {
  it("reads no output as a prefix that holds nothing", () => {
    expect(countPublishedObjects("")).toBe(0);
    expect(countPublishedObjects("  \n ")).toBe(0);
  });

  it("reads a listing with no keys as a prefix that holds nothing", () => {
    expect(countPublishedObjects('{"RequestCharged": null}')).toBe(0);
    expect(countPublishedObjects('{"Contents": null}')).toBe(0);
    // What `--max-keys 1` (pagination off) prints for an empty prefix.
    expect(
      countPublishedObjects(
        JSON.stringify({ IsTruncated: false, MaxKeys: 1, KeyCount: 0 }),
      ),
    ).toBe(0);
  });

  it("counts the keys a listing reports, by either field", () => {
    expect(
      countPublishedObjects(
        JSON.stringify({ Contents: [{ Key: `desktop/${V}/SHA256SUMS.txt` }] }),
      ),
    ).toBe(1);
    expect(
      countPublishedObjects(
        JSON.stringify({
          Contents: [{ Key: `desktop/${V}/SHA256SUMS.txt` }],
          KeyCount: 1,
          IsTruncated: true,
        }),
      ),
    ).toBe(1);
    // A KeyCount the truncated Contents does not show still counts.
    expect(countPublishedObjects('{"KeyCount": 7}')).toBe(7);
  });

  it("refuses to round an unreadable answer down to zero", () => {
    expect(countPublishedObjects("not json")).toBeNull();
    expect(countPublishedObjects("null")).toBeNull();
    expect(countPublishedObjects('"a string"')).toBeNull();
    expect(countPublishedObjects('{"Contents": 3}')).toBeNull();
    expect(countPublishedObjects('{"KeyCount": "1"}')).toBeNull();
  });
});

describe("decidePublication", () => {
  it("publishes a version whose prefix holds nothing", () => {
    expect(decide({ stdout: "" })).toEqual({ action: "publish" });
  });

  it("stops on a version that is already published", () => {
    const got = decide({
      stdout: JSON.stringify({ Contents: [{ Key: "k" }] }),
    });
    expect(got.action).toBe("stop");
    expect(got).toMatchObject({ code: 1, reason: "published" });
    if (got.action !== "stop") throw new Error("unreachable");
    expect(got.message).toContain("already published");
    expect(got.message).toContain("--allow-overwrite");
  });

  it("overwrites an already published version only when told to", () => {
    const got = decide(
      { stdout: JSON.stringify({ Contents: [{ Key: "k" }] }) },
      true,
    );
    expect(got.action).toBe("overwrite");
    if (got.action !== "overwrite") throw new Error("unreachable");
    expect(got.message).toContain("overwriting the published");
  });

  it("stops on every nonzero exit status, whatever --allow-overwrite says", () => {
    // 1 is the status `aws s3 ls` overloads for "empty prefix"; 253/254/255
    // are the aws-cli configuration/client/general failures. None of them is
    // an answer from `s3api list-objects-v2`, so none may be read as one.
    for (const status of [1, 2, 130, 252, 253, 254, 255]) {
      for (const allowOverwrite of [false, true]) {
        const got = decide({ status }, allowOverwrite);
        expect(got.action).toBe("stop");
        if (got.action !== "stop") throw new Error("unreachable");
        expect(got.message).toContain(`exited ${status}`);
        expect(got.message).toContain("unknown");
      }
    }
  });

  it("stops when aws never ran", () => {
    const got = decide({ status: null, spawnFailed: true });
    expect(got.action).toBe("stop");
    expect(got).toMatchObject({ reason: "unknown" });
    if (got.action !== "stop") throw new Error("unreachable");
    expect(got.message).toContain("could not be run");
  });

  it("stops when aws was killed by a signal", () => {
    const got = decide({ status: null, signal: "SIGKILL" });
    expect(got.action).toBe("stop");
    if (got.action !== "stop") throw new Error("unreachable");
    expect(got.message).toContain("SIGKILL");
  });

  it("stops when the listing cannot be read", () => {
    const got = decide({ stdout: "<html>proxy error</html>" });
    expect(got.action).toBe("stop");
    if (got.action !== "stop") throw new Error("unreachable");
    expect(got.message).toContain("not JSON");
  });
});

describe("reservationArgs", () => {
  const base = {
    bucket: "oxagen-downloads",
    key: `desktop/${V}/SHA256SUMS.txt`,
    body: "/tmp/SHA256SUMS.txt",
    cacheControl: "public, max-age=31536000, immutable",
  };

  it("claims the version with a conditional write", () => {
    const args = reservationArgs({ ...base, allowOverwrite: false });
    expect(args.slice(0, 2)).toEqual(["s3api", "put-object"]);
    expect(args).toContain("--if-none-match");
    expect(args[args.indexOf("--if-none-match") + 1]).toBe("*");
    expect(args[args.indexOf("--key") + 1]).toBe(base.key);
    expect(args[args.indexOf("--body") + 1]).toBe(base.body);
    expect(args[args.indexOf("--cache-control") + 1]).toBe(base.cacheControl);
  });

  it("drops the condition only for --allow-overwrite", () => {
    const args = reservationArgs({ ...base, allowOverwrite: true });
    expect(args).not.toContain("--if-none-match");
    expect(args).not.toContain("*");
  });
});

describe("reportPublicationDecision", () => {
  const stop = decidePublication(
    { ...OK, stdout: JSON.stringify({ KeyCount: 1 }) },
    OPTS,
  );
  const unknown = decidePublication({ ...OK, status: 254 }, OPTS);

  it("says nothing and carries on for a version that is free", () => {
    const got = reportPublicationDecision(
      { action: "publish" },
      {
        dryRun: false,
      },
    );
    expect(got).toEqual({ message: null, level: null, exitCode: null });
  });

  it("warns and carries on for an authorised overwrite", () => {
    const decision = decidePublication(
      { ...OK, stdout: JSON.stringify({ KeyCount: 1 }) },
      { ...OPTS, allowOverwrite: true },
    );
    const got = reportPublicationDecision(decision, { dryRun: false });
    expect(got.level).toBe("warn");
    expect(got.exitCode).toBeNull();
  });

  it("exits a real publish on a stop, with the decision's own code", () => {
    for (const decision of [stop, unknown]) {
      const got = reportPublicationDecision(decision, { dryRun: false });
      expect(got.level).toBe("error");
      expect(got.exitCode).toBe(1);
      expect(got.message).toBe(
        decision.action === "stop" ? decision.message : null,
      );
    }
  });

  it("never exits a dry run, because a dry run writes nothing", () => {
    for (const decision of [stop, unknown]) {
      const got = reportPublicationDecision(decision, { dryRun: true });
      expect(got.exitCode).toBeNull();
      expect(got.level).toBe("warn");
    }
  });

  it("still tells a dry run what a real publish would have decided", () => {
    const published = reportPublicationDecision(stop, { dryRun: true });
    expect(published.message).toContain("already published");
    // Marked as a warning, not a refusal it then has to take back.
    expect(published.message?.startsWith("! ")).toBe(true);
    expect(published.message).not.toContain("✖");
    expect(published.message).toContain("A real publish would stop here.");

    const couldNotCheck = reportPublicationDecision(unknown, { dryRun: true });
    expect(couldNotCheck.message).toContain("unknown");
    expect(couldNotCheck.message).toContain("the planned uploads follow");
  });
});

describe("resuming an interrupted publish", () => {
  it("uploads missing installers before publishing the page", () => {
    const dir = mkdtempSync(join(tmpdir(), "downloads-resume-test-"));
    try {
      const source = join(dir, "installers");
      const bin = join(dir, "bin");
      mkdirSync(source);
      mkdirSync(bin);
      const file = "Oxagen_2.1.1_aarch64.dmg";
      writeFileSync(join(source, file), "installer bytes");
      const statePath = join(dir, "bucket.json");
      writeFileSync(
        statePath,
        JSON.stringify({ objects: {}, interrupted: false, writes: [] }),
      );
      writeFileSync(
        join(bin, "aws"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const path = process.env.TEST_BUCKET_STATE;
const state = JSON.parse(fs.readFileSync(path, "utf8"));
const save = () => fs.writeFileSync(path, JSON.stringify(state));
const arg = (name) => args[args.indexOf(name) + 1];
if (args[0] === "s3api" && args[1] === "list-objects-v2") {
  const keys = Object.keys(state.objects).filter((key) => key.startsWith(arg("--prefix")));
  console.log(JSON.stringify({ KeyCount: keys.length, Contents: keys.map((Key) => ({ Key, Size: state.objects[Key].length, LastModified: "2026-09-19" })) }));
} else if (args[0] === "s3api" && args[1] === "put-object") {
  state.objects[arg("--key")] = fs.readFileSync(arg("--body"), "utf8");
  save();
} else if (args[0] === "s3" && args[1] === "cp") {
  if (args[3] === "-") {
    const found = state.objects[args[2].replace(/^s3:\\/\\/[^/]+\\//, "")];
    if (found === undefined) {
      console.error('fatal error: An error occurred (404) when calling the HeadObject operation: Key "' + args[2] + '" does not exist');
      process.exit(1);
    }
    process.stdout.write(found);
  } else if (args[2].startsWith("s3://")) {
    const from = args[2].replace(/^s3:\\/\\/[^/]+\\//, "");
    const key = args[3].replace(/^s3:\\/\\/[^/]+\\//, "");
    state.objects[key] = state.objects[from];
    state.disposition = { ...(state.disposition ?? {}), [key]: arg("--content-disposition") };
    state.writes.push(key);
    save();
  } else {
    const key = args[3].replace(/^s3:\\/\\/[^/]+\\//, "");
    if (key.endsWith(".dmg") && !state.interrupted) {
      state.interrupted = true;
      save();
      process.exit(1);
    }
    state.objects[key] = fs.readFileSync(args[2], "utf8");
    state.writes.push(key);
    save();
  }
} else if (args[0] === "cloudfront") {
  console.log("None");
} else {
  throw new Error("Unexpected AWS request: " + args.join(" "));
}
`,
        { mode: 0o755 },
      );
      const run = (...args: string[]) =>
        spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL("../scripts/publish-downloads.mjs", import.meta.url),
            ),
            "--dir",
            source,
            "--version",
            V,
            "--resume",
            ...args,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH ?? ""}`,
              TEST_BUCKET_STATE: statePath,
            },
          },
        );
      const first = run();
      expect(first.status, first.stderr).toBe(1);
      const interrupted = JSON.parse(readFileSync(statePath, "utf8")) as {
        objects: Record<string, string>;
      };
      expect(interrupted.objects[`desktop/${V}/SHA256SUMS.txt`]).toContain(
        file,
      );
      expect(interrupted.objects[`desktop/${V}/${file}`]).toBeUndefined();
      expect(interrupted.objects["index.html"]).toBeUndefined();
      const pageOnly = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../scripts/publish-downloads.mjs", import.meta.url),
          ),
          "--page-only",
          "--version",
          V,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            TEST_BUCKET_STATE: statePath,
          },
        },
      );
      expect(pageOnly.status, pageOnly.stderr).toBe(1);
      expect(pageOnly.stderr).toContain("Installers are missing");
      const refused = JSON.parse(readFileSync(statePath, "utf8")) as {
        objects: Record<string, string>;
        writes: string[];
      };
      expect(refused.objects["index.html"]).toBeUndefined();
      expect(refused.writes).not.toContain("index.html");
      const beforePreview = readFileSync(statePath, "utf8");
      const preview = run("--dry-run");
      expect(preview.status, preview.stderr).toBe(0);
      expect(preview.stdout).toContain(
        `[dry-run] aws s3 cp ${join(source, file)}`,
      );
      expect(preview.stdout).toContain("/index.html");
      expect(preview.stdout).toContain("/fonts/");
      expect(preview.stdout).toContain(
        "[dry-run] aws cloudfront create-invalidation",
      );
      expect(preview.stdout).toContain(`${file}  15 bytes`);
      expect(preview.stdout).toContain(
        "installer recovery and page publication planned",
      );
      expect(readFileSync(statePath, "utf8")).toBe(beforePreview);
      const resumed = run();
      expect(resumed.status, resumed.stderr).toBe(0);
      const complete = JSON.parse(readFileSync(statePath, "utf8")) as {
        objects: Record<string, string>;
        writes: string[];
      };
      expect(complete.objects[`desktop/${V}/${file}`]).toBe("installer bytes");
      expect(complete.objects["index.html"]).toContain(file);
      expect(complete.writes.indexOf(`desktop/${V}/${file}`)).toBeLessThan(
        complete.writes.indexOf("index.html"),
      );
      // The version-free links move with the page, after the installers and
      // before the page, and download under the versioned name.
      const stable = "latest/Oxagen_aarch64.dmg";
      expect(complete.objects[stable]).toBe("installer bytes");
      expect(
        (complete as unknown as { disposition: Record<string, string> })
          .disposition[stable],
      ).toBe(`attachment; filename="${file}"`);
      const manifest = JSON.parse(complete.objects["latest.json"]!) as {
        version: string;
        channel: string;
        installers: Array<{ latestUrl: string; url: string }>;
      };
      expect(manifest.version).toBe(V);
      expect(manifest.channel).toBe("release");
      expect(manifest.installers[0]?.latestUrl).toBe(
        "https://downloads.oxagen.sh/latest/Oxagen_aarch64.dmg",
      );
      expect(complete.writes.indexOf(`desktop/${V}/${file}`)).toBeLessThan(
        complete.writes.indexOf(stable),
      );
      expect(complete.writes.indexOf(stable)).toBeLessThan(
        complete.writes.indexOf("latest.json"),
      );
      expect(complete.writes.indexOf("latest.json")).toBeLessThan(
        complete.writes.indexOf("index.html"),
      );

      // A newer build already published: redrawing this older version moves
      // neither the links nor the page.
      const newer = JSON.parse(readFileSync(statePath, "utf8")) as {
        objects: Record<string, string>;
        writes: string[];
      };
      newer.objects["latest.json"] = JSON.stringify({ version: "2.1.2-4" });
      newer.objects["index.html"] = "the 2.1.2-4 page";
      newer.writes = [];
      writeFileSync(statePath, JSON.stringify(newer));
      const stale = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../scripts/publish-downloads.mjs", import.meta.url),
          ),
          "--page-only",
          "--version",
          V,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            TEST_BUCKET_STATE: statePath,
          },
        },
      );
      expect(stale.status, stale.stderr).toBe(0);
      expect(stale.stderr).toContain("latest is 2.1.2-4, newer than 2.1.1");
      const untouched = JSON.parse(readFileSync(statePath, "utf8")) as {
        objects: Record<string, string>;
        writes: string[];
      };
      expect(untouched.writes).toEqual([]);
      expect(untouched.objects["index.html"]).toBe("the 2.1.2-4 page");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
