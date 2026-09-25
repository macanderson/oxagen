/**
 * The `app` service ships whatever APP_DIR names, and nothing else. With
 * `@oxagen/app` written into the script, the app rebuild reached
 * app.oxagen.sh the moment its integration branch merged (#2894), while the
 * parity gates still pointed at apps/app_deprecated. One source of truth for
 * "which app is the app", read by the gates and by the deploy alike — and
 * when that source is not on the tree (no rebuild in flight), apps/app.
 *
 * `resolve_app_dir` is executed here, not pattern-matched: once in a scratch
 * tree carrying an app-dir.mjs and once in a tree without one.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STELLA_SERVE_PINNED_VERSION } from "../../packages/stella-engine-client/src/version";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const script = readFileSync(join(here, "package-for-node.sh"), "utf8");
const resolver = join(here, "lib", "app-dir.sh");

/** Run `resolve_app_dir` from the root of `tree`, as package-for-node.sh does. */
function resolveIn(tree: string): string {
  return execFileSync(
    "bash",
    [
      "-euo",
      "pipefail",
      "-c",
      `cd "$1" && . "$2" && resolve_app_dir`,
      "_",
      tree,
      resolver,
    ],
    { encoding: "utf8" },
  );
}

/** The `app)` arm of the service switch, comments removed. */
function appArm(source: string): string {
  const start = source.indexOf("\n  app)\n");
  const end = source.indexOf("\n  api)\n", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source
    .slice(start, end)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("resolve_app_dir", () => {
  it("returns APP_DIR when the rebuild's app-dir.mjs is on the tree", () => {
    const tree = mkdtempSync(join(tmpdir(), "app-dir-"));
    mkdirSync(join(tree, "tools", "scripts", "lib"), { recursive: true });
    writeFileSync(
      join(tree, "tools", "scripts", "lib", "app-dir.mjs"),
      'export const APP_DIR = "apps/app_deprecated";\n',
    );
    expect(resolveIn(tree)).toBe("apps/app_deprecated");
  });

  it("returns apps/app when app-dir.mjs is absent", () => {
    const tree = mkdtempSync(join(tmpdir(), "app-dir-"));
    expect(resolveIn(tree)).toBe("apps/app");
  });

  it("names, on this tree, a workspace package with a next build", () => {
    const appDir = resolveIn(root);
    expect(existsSync(join(root, appDir, "package.json"))).toBe(true);
    const pkg = JSON.parse(
      readFileSync(join(root, appDir, "package.json"), "utf8"),
    ) as { name: string; scripts: Record<string, string> };
    expect(pkg.name).toMatch(/^@oxagen\/app/);
    expect(pkg.scripts.build).toMatch(/next build/);
  });
});

describe("package-for-node.sh app", () => {
  const arm = appArm(script);

  it("takes its app from resolve_app_dir", () => {
    expect(arm).toMatch(/\. tools\/scripts\/lib\/app-dir\.sh/);
    expect(arm).toMatch(/app_dir=\$\(resolve_app_dir\)/);
  });

  it("names no app package by hand", () => {
    expect(arm).not.toMatch(/--filter\s+@oxagen\/app\b/);
    expect(arm).not.toMatch(/--filter\s+@oxagen\/app-deprecated\b/);
    expect(arm).not.toMatch(/assemble_next\s+apps\//);
  });
});

const engineVersionFile = join(
  "packages",
  "stella-engine-client",
  "src",
  "version.ts",
);
const engineVersionSource = readFileSync(join(root, engineVersionFile), "utf8");

interface EngineManifest {
  config_prefix: string;
  image: string;
}

/**
 * Package the engine in a scratch tree that holds the script and, unless
 * `versionSource` is null, that text as the engine client's version.ts.
 */
function engineManifest(
  prefix: string,
  {
    env = {},
    versionSource = engineVersionSource,
  }: { env?: Record<string, string>; versionSource?: string | null } = {},
): EngineManifest {
  const tree = mkdtempSync(join(tmpdir(), "node-manifest-"));
  const target = join(tree, "tools", "scripts", "package-for-node.sh");
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, script);
    if (versionSource !== null) {
      mkdirSync(dirname(join(tree, engineVersionFile)), { recursive: true });
      writeFileSync(join(tree, engineVersionFile), versionSource);
    }
    execFileSync("bash", [target, "stella-serve"], {
      env: { ...process.env, PARAMETER_PREFIX: prefix, ...env },
      stdio: "pipe",
    });
    return JSON.parse(
      readFileSync(
        join(tree, "dist-deploy", "stella-serve", "oxagen-run.json"),
        "utf8",
      ),
    ) as EngineManifest;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

/**
 * The engine's image tag is STELLA_SERVE_PINNED_VERSION and nothing else.
 * Every assistant run records that constant as its engine version, so a tag
 * from anywhere else would make the run ledger name an engine that is not
 * running. #2833 pinned the client at one release and deployed another.
 */
describe("package-for-node.sh stella-serve image", () => {
  const pin = (version: string) =>
    `export const STELLA_SERVE_PINNED_VERSION = "${version}";\n`;

  it("names the image tagged with the engine client's pinned version", () => {
    expect(engineManifest("").image).toBe(
      `ghcr.io/macanderson/stella-serve:${STELLA_SERVE_PINNED_VERSION}`,
    );
  });

  it("follows a bump of version.ts with no other change", () => {
    expect(
      engineManifest("", {
        versionSource: `/** A doc comment. */\n${pin("9.8.7")}`,
      }).image,
    ).toBe("ghcr.io/macanderson/stella-serve:9.8.7");
  });

  it("takes no tag from the environment", () => {
    expect(
      engineManifest("", { env: { STELLA_SERVE_IMAGE_TAG: "0.0.1" } }).image,
    ).toBe(`ghcr.io/macanderson/stella-serve:${STELLA_SERVE_PINNED_VERSION}`);
  });

  it("refuses to package the engine without a readable pin", () => {
    for (const versionSource of [
      null,
      "",
      pin("latest"),
      pin("0.9"),
      `${pin("0.9.1")}${pin("0.9.2")}`,
    ]) {
      expect(() => engineManifest("", { versionSource })).toThrow(
        "cannot read STELLA_SERVE_PINNED_VERSION",
      );
    }
  });
});

describe("artifact configuration isolation", () => {
  it("preserves the production default for existing deploys", () => {
    expect(engineManifest("").config_prefix).toBe(
      "/oxagen/production/stella-serve",
    );
  });

  it("packages the isolated environment prefix without a production fallback", () => {
    expect(engineManifest("/oxagen/staging").config_prefix).toBe(
      "/oxagen/staging/stella-serve",
    );
  });

  it("refuses a malformed prefix before producing an artifact", () => {
    for (const prefix of [
      "oxagen/staging",
      "/oxagen//staging",
      "/oxagen/../production",
    ]) {
      expect(() => engineManifest(prefix)).toThrow(
        "PARAMETER_PREFIX must be an absolute SSM path",
      );
    }
  });
});
