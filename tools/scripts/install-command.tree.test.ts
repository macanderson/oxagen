/**
 * Keeps the CLI install command pointed at a host that serves the script
 * (#4960). The docs site serves `apps/docs/public/install.sh` at
 * https://docs.oxagen.sh/install.sh, and the script downloads the executable
 * for each platform from https://downloads.oxagen.sh/latest. For months the
 * docs named `cli.oxagen.sh`, which had no DNS record, and the script fetched
 * file names nothing published, so the first command on the docs home page
 * failed for everyone.
 *
 * This reads files outside @oxagen/scripts, so it is a `*.tree.test.ts` and
 * `pnpm check:tree-guards` runs it uncached (#4664 item 2).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_URL = "https://docs.oxagen.sh/install.sh";
const SCRIPT_PATH = "apps/docs/public/install.sh";

/** The places a person reads the install command. ADRs and changelogs keep their history. */
const SCANNED = [
  "apps/docs/src",
  "apps/docs/content",
  "docs/guides",
  "packages/config/src",
  "README.md",
  "apps/cli/README.md",
];
const TEXT = /\.(ts|tsx|md|mdx|json)$/;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function files(path: string): string[] {
  const abs = join(ROOT, path);
  if (!existsSync(abs)) return [];
  if (TEXT.test(path)) return [path];
  return readdirSync(abs, { recursive: true, encoding: "utf8" })
    .filter((f) => TEXT.test(f) && !f.includes("node_modules"))
    .map((f) => join(path, f));
}

/** Every Oxagen-hosted `…/install.sh` URL in a file, with its line number. */
function oxagenScriptUrls(text: string): Array<{ line: number; url: string }> {
  const found: Array<{ line: number; url: string }> = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/https?:\/\/([a-z0-9.-]+)\/install\.sh/gi)) {
      const host = m[1]?.toLowerCase() ?? "";
      if (host === "oxagen.sh" || host.endsWith(".oxagen.sh")) {
        found.push({ line: i + 1, url: m[0] });
      }
    }
  });
  return found;
}

describe("the CLI install command", () => {
  it("is defined once, as the docs host's install.sh", () => {
    const lib = read("apps/docs/src/lib/install.ts");
    expect(lib).toContain(`INSTALL_SCRIPT_URL = "${SCRIPT_URL}"`);
    expect(existsSync(join(ROOT, SCRIPT_PATH)), SCRIPT_PATH).toBe(true);
  });

  it("names no other Oxagen host for install.sh on any page, component, or guide", () => {
    const wrong: string[] = [];
    for (const path of SCANNED.flatMap(files)) {
      for (const { line, url } of oxagenScriptUrls(read(path))) {
        if (url !== SCRIPT_URL) wrong.push(`${path}:${line} ${url}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps docs components on the shared constant", () => {
    const inline = files("apps/docs/src")
      .filter((path) => path !== join("apps/docs/src", "lib", "install.ts"))
      .filter((path) => /const INSTALL_CMD\s*=/.test(read(path)));
    expect(inline).toEqual([]);
  });
});

describe("install.sh", () => {
  const script = read(SCRIPT_PATH);

  it("downloads from downloads.oxagen.sh/latest by default", () => {
    expect(script).toContain(
      'BASE="${OXAGEN_INSTALL_BASE:-https://downloads.oxagen.sh/latest}"',
    );
    expect(script).toContain('ASSET="oxagen-$TRIPLE"');
  });

  it("maps only to executables the release publishes", () => {
    const published = [
      ...read("apps/desktop/src/downloads.ts").matchAll(
        /\{\s*triple:\s*"([^"]+)"/g,
      ),
    ].map((m) => m[1]);
    expect(published.length).toBeGreaterThan(0);
    const mapped = [...script.matchAll(/TRIPLE="([^"]+)"/g)].map((m) => m[1]);
    expect(mapped.length).toBeGreaterThan(0);
    for (const triple of mapped) {
      expect(published, `install.sh maps ${triple}`).toContain(triple);
    }
  });
});
