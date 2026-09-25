import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checksumLine,
  listAssets,
  parseChecksums,
  writeChecksums,
} from "../packaging/checksums.mjs";
import {
  applyDirectives,
  readDigests,
  stamp,
  stampAll,
  TEMPLATES,
} from "../packaging/stamp.mjs";

const scratch: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "oxagen-packaging-"));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true });
});

const hex = (text: string) => createHash("sha256").update(text).digest("hex");

describe("checksums", () => {
  it("writes sha256sum lines that parse back to the same digest", () => {
    const line = checksumLine("tacho-aarch64-apple-darwin", Buffer.from("abc"));
    expect(line).toBe(`${hex("abc")}  tacho-aarch64-apple-darwin\n`);
    expect(parseChecksums(line).get("tacho-aarch64-apple-darwin")).toBe(
      hex("abc"),
    );
  });

  it("accepts the binary marker and rejects a line that is not a digest", () => {
    expect(parseChecksums(`${hex("x")} *oxagen.exe\n`).get("oxagen.exe")).toBe(
      hex("x"),
    );
    expect(() => parseChecksums("not a digest  file")).toThrow(
      /not a sha256sum line/,
    );
  });

  it("checksums every plain file in a directory, skipping dotfiles and .sha256", () => {
    const dir = tmp();
    writeFileSync(join(dir, "tacho-x86_64-unknown-linux-gnu"), "tacho");
    writeFileSync(join(dir, "oxagen-x86_64-unknown-linux-gnu"), "oxagen");
    writeFileSync(join(dir, ".DS_Store"), "");
    writeFileSync(join(dir, "stale.sha256"), "");
    const written = writeChecksums([dir]).map((p) => p.slice(dir.length + 1));
    expect(written.sort()).toEqual([
      "oxagen-x86_64-unknown-linux-gnu.sha256",
      "tacho-x86_64-unknown-linux-gnu.sha256",
    ]);
    expect(
      readFileSync(join(dir, "tacho-x86_64-unknown-linux-gnu.sha256"), "utf8"),
    ).toBe(`${hex("tacho")}  tacho-x86_64-unknown-linux-gnu\n`);
    expect(listAssets(join(dir, "stale.sha256"))).toEqual([
      join(dir, "stale.sha256"),
    ]);
  });
});

describe("stamp", () => {
  const digests = new Map([
    ["Oxagen_2.1.1_aarch64.dmg", "a".repeat(64)],
    ["Oxagen_2.1.1_x64.dmg", "b".repeat(64)],
  ]);

  it("expands version inside an asset token before looking the digest up", () => {
    const out = stamp(
      'url "…/desktop-v{{version}}/x"\nsha256 "{{sha256:Oxagen_{{version}}_x64.dmg}}"',
      { version: "2.1.1", digests },
    );
    expect(out).toBe(`url "…/desktop-v2.1.1/x"\nsha256 "${"b".repeat(64)}"`);
  });

  it("replaces the line after a run of stamp directives with their texts", () => {
    const text = [
      '  version "{{version}}"',
      '  # stamp: sha256 arm:   "{{sha256:Oxagen_{{version}}_aarch64.dmg}}",',
      '  # stamp:        intel: "{{sha256:Oxagen_{{version}}_x64.dmg}}"',
      "  sha256 :no_check",
      '  app "Oxagen.app"',
    ].join("\n");
    expect(applyDirectives(text)).not.toContain(":no_check");
    const out = stamp(text, { version: "2.1.1", digests });
    expect(out.split("\n")).toEqual([
      '  version "2.1.1"',
      `  sha256 arm:   "${"a".repeat(64)}",`,
      `         intel: "${"b".repeat(64)}"`,
      '  app "Oxagen.app"',
    ]);
    // A lone directive still replaces exactly one line.
    expect(applyDirectives("# stamp: x\ny\nz")).toBe("x\nz");
  });

  it("refuses a token with no digest and a version that is not a release", () => {
    expect(() =>
      stamp("{{sha256:tacho-aarch64-apple-darwin}}", {
        version: "2.1.1",
        digests,
      }),
    ).toThrow(/no \.sha256 for release asset tacho-aarch64-apple-darwin/);
    expect(() => stamp("x", { version: "desktop-v2.1.1", digests })).toThrow(
      /not a release version/,
    );
    expect(() => applyDirectives("# stamp: last line")).toThrow(
      /needs a line after it/,
    );
  });

  it("renders all three checked-in templates with no token left behind", () => {
    const sums = tmp();
    const assets = [
      "Oxagen_2.1.1_aarch64.dmg",
      "Oxagen_2.1.1_x64.dmg",
      "tacho-aarch64-apple-darwin",
      "oxagen-aarch64-apple-darwin",
      "tacho-x86_64-apple-darwin",
      "oxagen-x86_64-apple-darwin",
      "tacho-x86_64-unknown-linux-gnu",
      "oxagen-x86_64-unknown-linux-gnu",
      "tacho-x86_64-pc-windows-msvc.exe",
      "oxagen-x86_64-pc-windows-msvc.exe",
    ];
    for (const asset of assets) {
      writeFileSync(
        join(sums, `${asset}.sha256`),
        checksumLine(asset, Buffer.from(asset)),
      );
    }
    expect(readDigests(sums).size).toBe(assets.length);

    const out = tmp();
    const written = stampAll({ version: "2.1.1", sums, out });
    expect(written.map((p) => p.slice(out.length + 1))).toEqual(TEMPLATES);
    for (const file of written) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/\{\{|^\s*#\s*stamp:/m);
      expect(text).toContain('"2.1.1"');
    }
    const cask = readFileSync(join(out, "homebrew/oxagen.rb"), "utf8");
    expect(cask).not.toMatch(/^\s*sha256 :no_check/m);
    // macOS 15 removed the Control-click Open override, so the caveat gives
    // the Privacy & Security route instead (#4252).
    expect(cask).toContain("click Open Anyway");
    expect(cask).not.toMatch(/(right|control|ctrl)[- ]click/i);
    expect(cask).toContain(
      `  sha256 arm:   "${hex("Oxagen_2.1.1_aarch64.dmg")}",\n         intel: "${hex("Oxagen_2.1.1_x64.dmg")}"\n`,
    );
    const manifest = JSON.parse(
      readFileSync(join(out, "scoop/oxagen.json"), "utf8"),
    ) as {
      version: string;
      architecture: { "64bit": { url: string[]; hash: string[] } };
    };
    expect(manifest.version).toBe("2.1.1");
    expect(manifest.architecture["64bit"].url[0]).toContain("desktop-v2.1.1/");
    expect(manifest.architecture["64bit"].hash).toEqual([
      hex("tacho-x86_64-pc-windows-msvc.exe"),
      hex("oxagen-x86_64-pc-windows-msvc.exe"),
    ]);
  });

  it("stamps the checked-in formula only when every asset it names has a digest", () => {
    const sums = tmp();
    writeFileSync(
      join(sums, "tacho-aarch64-apple-darwin.sha256"),
      checksumLine("tacho-aarch64-apple-darwin", Buffer.from("t")),
    );
    expect(() => stampAll({ version: "2.1.1", sums, out: tmp() })).toThrow(
      /no \.sha256 for release asset Oxagen_2\.1\.1_aarch64\.dmg/,
    );
  });
});
