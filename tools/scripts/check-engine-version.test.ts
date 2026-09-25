/**
 * The guard that holds every `stella-serve` image tag to the engine client's
 * pin. It has to fail when a bump misses a file, and it has to read the real
 * compose file, or it passes while the two drift. #2833 pinned the client at
 * one release and deployed another, and nothing noticed.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STELLA_SERVE_PINNED_VERSION } from "../../packages/stella-engine-client/src/version";
import {
  findDrift,
  findTags,
  isScanned,
  readPinnedVersion,
  VERSION_FILE,
} from "./check-engine-version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const pin = (version: string) =>
  `export const STELLA_SERVE_PINNED_VERSION = "${version}";\n`;

const compose = (version: string) =>
  "services:\n" +
  "  stella-serve:\n" +
  `    image: ghcr.io/macanderson/stella-serve:\${STELLA_SERVE_IMAGE_TAG:-${version}}\n`;

describe("readPinnedVersion", () => {
  it("reads the pin from this tree's version.ts", () => {
    const source = readFileSync(join(root, VERSION_FILE), "utf8");
    expect(readPinnedVersion(source)).toBe(STELLA_SERVE_PINNED_VERSION);
  });

  it("reads a pin under a doc comment", () => {
    expect(readPinnedVersion(`/** The engine. */\n${pin("1.2.3")}`)).toBe(
      "1.2.3",
    );
  });

  it("refuses a file without the pin", () => {
    expect(readPinnedVersion("")).toBeNull();
    expect(
      readPinnedVersion("export const STELLA_SERVE_PINNED_VERSION = V;\n"),
    ).toBeNull();
  });

  it("refuses a second pin", () => {
    expect(readPinnedVersion(pin("1.2.3") + pin("1.2.4"))).toBeNull();
  });

  it("refuses a value that is not a plain version", () => {
    for (const value of ["", "latest", "0.9", "0.9.414-rc.1", "v0.9.414"]) {
      expect(readPinnedVersion(pin(value))).toBeNull();
    }
  });
});

describe("findTags", () => {
  it("reads a compose default once, though both patterns match it", () => {
    expect(findTags(compose("0.9.1"))).toEqual([{ line: 3, tag: "0.9.1" }]);
  });

  it("reads a plain image reference, suffix included", () => {
    const plain = "image: ghcr.io/macanderson/stella-serve:1.2.3";
    const suffixed = '"ghcr.io/macanderson/stella-serve:1.2.3-arm64"';
    expect(findTags(plain)).toEqual([{ line: 1, tag: "1.2.3" }]);
    expect(findTags(suffixed)).toEqual([{ line: 1, tag: "1.2.3-arm64" }]);
  });

  it("reads a literal given to the override variable", () => {
    for (const line of [
      'STELLA_SERVE_IMAGE_TAG="${STELLA_SERVE_IMAGE_TAG:-0.9.2}"',
      "STELLA_SERVE_IMAGE_TAG=0.9.2",
      "      STELLA_SERVE_IMAGE_TAG: 0.9.2",
      "      STELLA_SERVE_IMAGE_TAG: '0.9.2'",
    ]) {
      expect(findTags(line)).toEqual([{ line: 1, tag: "0.9.2" }]);
    }
  });

  it("stops a tag before a sentence's closing period", () => {
    expect(findTags("It runs stella-serve:0.9.3.")).toEqual([
      { line: 1, tag: "0.9.3" },
    ]);
  });

  it("ignores a tag that is not a version, and a host and port", () => {
    for (const line of [
      "image: ghcr.io/macanderson/stella-serve:latest",
      'WRITE_MANIFEST_IMAGE="ghcr.io/macanderson/stella-serve:$engine_tag"',
      "image: ghcr.io/macanderson/stella-serve:${STELLA_SERVE_IMAGE_TAG}",
      "`ghcr.io/macanderson/stella-serve:<version>`",
      "STELLA_SERVE_URL: http://stella-serve:8080",
      "  stella-serve:",
    ]) {
      expect(findTags(line)).toEqual([]);
    }
  });
});

describe("isScanned", () => {
  it("scans the files that can choose an image", () => {
    for (const path of [
      "docker-compose.dev.yml",
      ".github/workflows/pipeline.yml",
      "tools/scripts/package-for-node.sh",
      "infra/modules/isolated-environment/runtime.tf",
      "packages/tacho/container/Dockerfile",
      ".env.example",
      "tools/scripts/deploy.ts",
    ]) {
      expect(isScanned(path), path).toBe(true);
    }
  });

  it("skips prose, tests, and binaries", () => {
    for (const path of [
      "docs/adr/ADR-053-stella-serve.md",
      "infra/tools/node/README.md",
      "tools/scripts/check-engine-version.test.ts",
      "apps/web/public/logo.png",
      "Makefile",
    ]) {
      expect(isScanned(path), path).toBe(false);
    }
  });
});

describe("findDrift", () => {
  it("passes when every literal equals the pin", () => {
    expect(
      findDrift(
        [{ path: "docker-compose.dev.yml", contents: compose("0.9.414") }],
        "0.9.414",
      ),
    ).toEqual([]);
  });

  it("names the file, line, and tag of each literal that differs", () => {
    expect(
      findDrift(
        [
          { path: "docker-compose.dev.yml", contents: compose("0.9.414") },
          {
            path: "infra/x.tf",
            contents: 'a = 1\nimage = "stella-serve:0.9.9"',
          },
        ],
        "0.9.415",
      ),
    ).toEqual([
      { path: "docker-compose.dev.yml", line: 3, tag: "0.9.414" },
      { path: "infra/x.tf", line: 2, tag: "0.9.9" },
    ]);
  });
});

describe("this tree", () => {
  it("defaults the dev engine to the pinned version", () => {
    const contents = readFileSync(join(root, "docker-compose.dev.yml"), "utf8");
    expect(findTags(contents).map((hit) => hit.tag)).toEqual([
      STELLA_SERVE_PINNED_VERSION,
    ]);
  });
});

/**
 * The script end to end, in a scratch repository: it reads the pin, lists the
 * tracked files, and exits 1 on drift. This is the witness for "changing one
 * without the other fails CI".
 */
describe("check-engine-version.mjs", () => {
  let tree = "";

  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(join(tree, path), contents);
  };

  const run = () => {
    const result = spawnSync(
      process.execPath,
      [join(tree, "tools", "scripts", "check-engine-version.mjs")],
      { cwd: tree, encoding: "utf8" },
    );
    return { status: result.status, stderr: result.stderr };
  };

  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), "engine-version-"));
    write(
      "tools/scripts/check-engine-version.mjs",
      readFileSync(join(here, "check-engine-version.mjs"), "utf8"),
    );
    write(VERSION_FILE, pin("0.9.414"));
    write("docker-compose.dev.yml", compose("0.9.414"));
    // No ambient git config: a machine whose excludes file ignores one of
    // these paths would fail `git add` for reasons unrelated to the code.
    const git = (args: string[]) =>
      spawnSync("git", args, {
        cwd: tree,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      }).status;
    expect(git(["init", "-q"])).toBe(0);
    expect(git(["add", "."])).toBe(0);
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  it("passes when the compose default equals the pin", () => {
    expect(run().status).toBe(0);
  });

  it("fails when the pin moves and the compose default does not", () => {
    write(VERSION_FILE, pin("0.9.415"));
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain("docker-compose.dev.yml:3  0.9.414");
  });

  it("fails when the compose default moves and the pin does not", () => {
    write("docker-compose.dev.yml", compose("0.9.415"));
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain("docker-compose.dev.yml:3  0.9.415");
  });

  it("fails when the pin cannot be read", () => {
    write(VERSION_FILE, "export const STELLA_SERVE_PINNED_VERSION = V;\n");
    const { status, stderr } = run();
    expect(status).toBe(1);
    expect(stderr).toContain("cannot read the pin");
  });

  it("ignores a file git does not track", () => {
    write("scratch/compose.yml", compose("0.0.1"));
    expect(run().status).toBe(0);
  });
});
