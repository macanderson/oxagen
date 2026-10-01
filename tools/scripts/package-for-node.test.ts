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

  // The run of resolve_app_dir on this tree reads the live tree, so it lives in
  // package-for-node.tree.test.ts.
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
 * Run the script's own `write_manifest` for a Node service, as the `app`,
 * `api` and `mcp` arms call it, and read the manifest it wrote.
 */
function nodeManifest(env: Record<string, string>): {
  env: Record<string, string>;
} {
  const start = script.indexOf("write_manifest() {");
  const end = script.indexOf("\n}\n", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const out = mkdtempSync(join(tmpdir(), "node-manifest-"));
  try {
    execFileSync(
      "bash",
      [
        "-euo",
        "pipefail",
        "-c",
        `log() { :; }\nfail() { printf 'error: %s\\n' "$*" >&2; exit 1; }\n${script.slice(start, end + 2)}\nOUT="$1"\nwrite_manifest 3000 512m /api/health ""`,
        "_",
        out,
      ],
      { env: { ...process.env, ...env }, stdio: "pipe" },
    );
    return JSON.parse(readFileSync(join(out, "oxagen-run.json"), "utf8")) as {
      env: Record<string, string>;
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// #3841: a page's error line prints the region beside the trace id, and the
// app reads it from OXAGEN_REGION, which no manifest set.
describe("package-for-node.sh region", () => {
  it("sets the region every deployed node runs in", () => {
    expect(nodeManifest({ OXAGEN_REGION: "" }).env).toEqual({
      NEXT_TELEMETRY_DISABLED: "1",
      OXAGEN_REGION: "us-east-1",
    });
  });

  it("takes another region the environment names", () => {
    expect(nodeManifest({ OXAGEN_REGION: "eu-west-1" }).env.OXAGEN_REGION).toBe(
      "eu-west-1",
    );
  });
});

// Production's APP_URL reached the build and never the running app, because
// the node starts a container with Parameter Store alone and no parameter held
// it. build-env.ts --runtime-out writes the registry's static values that
// Parameter Store lacks, and the manifest carries them.
describe("package-for-node.sh runtime env", () => {
  function runtimeFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "runtime-env-"));
    const file = join(dir, "runtime-env.json");
    writeFileSync(file, contents);
    return file;
  }

  it("carries the static values build-env wrote into the manifest", () => {
    const file = runtimeFile('{"APP_URL":"https://app.example"}');
    expect(
      nodeManifest({ RUNTIME_ENV_FILE: file, OXAGEN_REGION: "" }).env,
    ).toEqual({
      APP_URL: "https://app.example",
      NEXT_TELEMETRY_DISABLED: "1",
      OXAGEN_REGION: "us-east-1",
    });
  });

  it("keeps the manifest's own region over the file's", () => {
    const file = runtimeFile('{"OXAGEN_REGION":"xx-west-9"}');
    expect(
      nodeManifest({ RUNTIME_ENV_FILE: file, OXAGEN_REGION: "" }).env
        .OXAGEN_REGION,
    ).toBe("us-east-1");
  });

  it("refuses a file that is not an object of string values", () => {
    expect(() =>
      nodeManifest({ RUNTIME_ENV_FILE: runtimeFile('{"PORT":3000}') }),
    ).toThrow();
    expect(() =>
      nodeManifest({ RUNTIME_ENV_FILE: runtimeFile('["APP_URL"]') }),
    ).toThrow();
  });

  it("refuses a file that is not there", () => {
    expect(() =>
      nodeManifest({
        RUNTIME_ENV_FILE: join(tmpdir(), "no-such-runtime-env.json"),
      }),
    ).toThrow();
  });
});

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
