import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  artifactDownloadCurl,
  classifyInstaller,
  countPublishedObjects,
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
  tempDirTracker,
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
      // The script's own temp directories land here, so the test can see
      // whether every exit path removed them.
      const scratch = join(dir, "tmp");
      mkdirSync(scratch);
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
    process.stdout.write(state.objects[args[2].replace(/^s3:\\/\\/[^/]+\\//, "")]);
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
              TMPDIR: scratch,
            },
          },
        );
      const first = run();
      expect(first.status, first.stderr).toBe(1);
      // A failed upload exits through sh()'s process.exit, which used to
      // leave the work directory behind.
      expect(readdirSync(scratch)).toEqual([]);
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
            TMPDIR: scratch,
          },
        },
      );
      expect(pageOnly.status, pageOnly.stderr).toBe(1);
      expect(pageOnly.stderr).toContain("Installers are missing");
      expect(readdirSync(scratch)).toEqual([]);
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
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("artifactDownloadCurl", () => {
  const url = "https://api.github.com/repos/o/r/actions/artifacts/7/zip";

  it("keeps the token off the argv and puts it in the stdin config", () => {
    const { args, config } = artifactDownloadCurl({
      token: "ghs_secret",
      url,
      output: "/tmp/a.zip",
    });
    expect(args.join(" ")).not.toContain("ghs_secret");
    expect(args).not.toContain("-H");
    expect(args).toEqual(
      expect.arrayContaining(["--config", "-", "-o", "/tmp/a.zip", url]),
    );
    expect(config).toBe('header = "Authorization: Bearer ghs_secret"\n');
  });

  it("escapes backslashes and quotes for curl's quoted config value", () => {
    const { config } = artifactDownloadCurl({
      token: 'a"b\\c',
      url,
      output: "o",
    });
    expect(config).toBe('header = "Authorization: Bearer a\\"b\\\\c"\n');
  });

  it("refuses a token that would end the config line", () => {
    for (const token of [
      "a\nurl = https://evil",
      "a\rb",
      "a\u0000b",
      "a\u007fb",
    ])
      expect(() => artifactDownloadCurl({ token, url, output: "o" })).toThrow(
        "control character",
      );
  });

  it("refuses an empty token", () => {
    expect(() => artifactDownloadCurl({ token: "", url, output: "o" })).toThrow(
      "gh auth login",
    );
  });
});

describe("tempDirTracker", () => {
  it("removes every tracked directory once, in the order made", () => {
    const removed: string[] = [];
    const temps = tempDirTracker((path) => removed.push(path));
    expect(temps.track("/t/a")).toBe("/t/a");
    temps.track("/t/b");
    expect(temps.tracked()).toEqual(["/t/a", "/t/b"]);
    temps.cleanup();
    temps.cleanup();
    expect(removed).toEqual(["/t/a", "/t/b"]);
    expect(temps.tracked()).toEqual([]);
  });

  it("reports a failed removal and still removes the rest", () => {
    const removed: string[] = [];
    const failures: string[] = [];
    const temps = tempDirTracker(
      (path) => {
        if (path === "/t/a") throw new Error("busy");
        removed.push(path);
      },
      (path) => failures.push(path),
    );
    temps.track("/t/a");
    temps.track("/t/b");
    temps.cleanup();
    expect(failures).toEqual(["/t/a"]);
    expect(removed).toEqual(["/t/b"]);
  });

  it("swallows a failed removal when no reporter is given", () => {
    const temps = tempDirTracker(() => {
      throw new Error("busy");
    });
    temps.track("/t/a");
    expect(() => temps.cleanup()).not.toThrow();
  });
});

describe("downloading a run's artifacts", () => {
  it("hands curl the token on stdin and removes its temp directory when curl fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "downloads-run-test-"));
    try {
      const bin = join(dir, "bin");
      const scratch = join(dir, "tmp");
      const record = join(dir, "curl.json");
      mkdirSync(bin);
      mkdirSync(scratch);
      // An empty listing: the version is free, so the script goes on to fetch.
      writeFileSync(
        join(bin, "aws"),
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "s3api" && args[1] === "list-objects-v2") process.exit(0);
throw new Error("Unexpected AWS request: " + args.join(" "));
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "gh"),
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "token") console.log("ghs_run_test_secret");
else if (args[0] === "api") console.log(JSON.stringify({ artifacts: [{ name: "oxagen-desktop-macos", id: 7, size_in_bytes: 1000 }] }));
else throw new Error("Unexpected gh request: " + args.join(" "));
`,
        { mode: 0o755 },
      );
      // Records what it was given, then fails the way a 404 with -f would.
      writeFileSync(
        join(bin, "curl"),
        `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.TEST_CURL_RECORD, JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8") }));
process.exit(22);
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../scripts/publish-downloads.mjs", import.meta.url),
          ),
          "--run",
          "123",
          "--version",
          V,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            TEST_CURL_RECORD: record,
            TMPDIR: scratch,
          },
        },
      );
      expect(result.status, result.stderr).toBe(22);
      expect(existsSync(record)).toBe(true);
      const seen = JSON.parse(readFileSync(record, "utf8")) as {
        args: string[];
        stdin: string;
      };
      expect(seen.args.join(" ")).not.toContain("ghs_run_test_secret");
      expect(seen.stdin).toBe(
        'header = "Authorization: Bearer ghs_run_test_secret"\n',
      );
      expect(result.stderr).not.toContain("ghs_run_test_secret");
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
