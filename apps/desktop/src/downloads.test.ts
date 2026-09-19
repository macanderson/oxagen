import { describe, expect, it } from "vitest";
import {
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
    expect(got).toMatchObject({ code: 1 });
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
