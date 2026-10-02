/**
 * Publish `@oxagen/cli` to npm from the tree, as a single-file bundle with a
 * clean manifest. Shared by `publish-cli-npm.ts` (npm.yml, after every
 * production deploy and every release), `release.ts` (publish as part of the
 * bump) and `release-publish.ts` (publish once the tagged build is green).
 *
 * Publishing apps/cli/package.json directly is BROKEN: its deps carry
 * `@oxagen/*: workspace:*` (unpublished, protocol leaks) and its bin shebang is
 * `tsx`, so `npm i -g @oxagen/cli` fails in a clean env. See
 * apps/cli/scripts/bundle.mjs and prepare-standalone-publish.mjs for the why.
 *
 * `latest` only moves forward (ADR-253). A release `X.Y.Z` and a build of main
 * `X.Y.(Z+1)-N` both publish under `latest`, the same rule the downloads host
 * follows for its `latest/` links. A version older than the newest one on npm
 * is not published, and after each publish `latest` is checked again, because
 * two runs can publish at once and the slower one would otherwise leave
 * `latest` on the older version.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "node:process";
import kleur from "kleur";
import { compareVersions, newestVersion } from "./build-version";
import { formatError } from "./format-error";

const ROOT = resolve(import.meta.dirname, "../../..");
const DIST_DIR = join(ROOT, "apps/cli/dist-standalone");

export const CLI_PACKAGE = "@oxagen/cli";

/** Env values pasted into a Vercel dashboard arrive double-quoted; strip one pair. */
function deQuote(v: string | undefined): string {
  if (!v) return "";
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"')
    ? v.slice(1, -1)
    : v;
}

/**
 * Runs npm with `args` in `cwd` and returns its stdout. Throws on a non-zero
 * exit. Injected so the tests can stand in for the registry.
 */
export type NpmRunner = (
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
) => string;

const runNpm: NpmRunner = (args, opts) =>
  execFileSync("npm", args, {
    cwd: opts.cwd,
    env: opts.env ?? env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

/** What the registry holds for the CLI package. */
export interface RegistryState {
  versions: string[];
  /** The version the `latest` dist-tag names, or null when it names none. */
  latest: string | null;
}

/**
 * Reads the output of `npm view @oxagen/cli versions dist-tags --json`. npm
 * prints `versions` as a bare string when the package has one version.
 */
export function parseRegistryState(json: string): RegistryState {
  const data = JSON.parse(json) as {
    versions?: string | string[];
    "dist-tags"?: Record<string, string>;
  };
  const versions =
    typeof data.versions === "string" ? [data.versions] : (data.versions ?? []);
  return { versions, latest: data["dist-tags"]?.latest ?? null };
}

/**
 * The registry's view of the CLI package. `--prefer-online` skips npm's local
 * cache, so a version published a minute ago is not missed.
 */
export function readRegistryState(npm: NpmRunner = runNpm): RegistryState {
  const out = npm(
    ["view", CLI_PACKAGE, "versions", "dist-tags", "--json", "--prefer-online"],
    { cwd: ROOT },
  );
  return parseRegistryState(out);
}

/** True when `@oxagen/cli@version` is already on the registry. */
export function npmVersionExists(
  version: string,
  npm: NpmRunner = runNpm,
): boolean {
  try {
    return readRegistryState(npm).versions.includes(version);
  } catch {
    return false;
  }
}

/** Whether to publish `version`, and why not when the answer is no. */
export type PublishPlan = { publish: true } | { publish: false; reason: string };

export function planPublish(
  state: RegistryState,
  version: string,
): PublishPlan {
  if (state.versions.includes(version))
    return {
      publish: false,
      reason: `${CLI_PACKAGE}@${version} is already on npm`,
    };
  const newest = newestVersion(state.versions);
  if (newest !== null && compareVersions(version, newest) < 0)
    return {
      publish: false,
      reason: `npm already holds ${newest}, which is newer than ${version}`,
    };
  return { publish: true };
}

/**
 * The version `latest` should name when it names an older one, or null when
 * it is already right.
 */
export function latestCorrection(state: RegistryState): string | null {
  const newest = newestVersion(state.versions);
  if (newest === null || newest === state.latest) return null;
  return newest;
}

export function npmCfg(): { token: string } | null {
  const token = deQuote(env.NPM_TOKEN);
  if (!token) {
    console.log(
      kleur.dim("[release] NPM_TOKEN not set — skipping npm publish."),
    );
    return null;
  }
  return { token };
}

/**
 * Build the standalone, publishable CLI artifact under apps/cli/dist-standalone/:
 * a single self-contained `oxagen.mjs` (every @oxagen/* and npm dep inlined, runs
 * under plain `node`) plus a clean manifest with NO `workspace:*` deps. Publishing
 * apps/cli/package.json directly is BROKEN — its deps carry `@oxagen/*:
 * workspace:*` (unpublished, protocol leaks) and its bin shebang is `tsx`, so
 * `npm i -g @oxagen/cli` fails in a clean env. See apps/cli/scripts/bundle.mjs +
 * prepare-standalone-publish.mjs for the full why. Must run AFTER the version
 * bump: the CLI inlines apps/cli/package.json at bundle time, so the bumped
 * version is what gets baked into oxagen.mjs.
 */
function buildCliBundle(): void {
  console.log(kleur.dim("    bundling standalone CLI..."));
  try {
    execFileSync("pnpm", ["-C", "apps/cli", "publish:standalone"], {
      cwd: ROOT,
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`CLI bundle failed: ${formatError(err)}`);
  }
}

interface PublishManifest {
  name?: string;
  version?: string;
  private?: boolean;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
}

/**
 * Refuse a publish manifest with one of the historical failure modes:
 * private, missing bin, version drift, or leaked `workspace:*` deps.
 */
export function manifestProblem(
  manifest: PublishManifest,
  version: string,
): string | null {
  if (manifest.private)
    return 'CLI manifest has "private": true — cannot publish';
  if (!manifest.bin || Object.keys(manifest.bin).length === 0)
    return "CLI manifest missing bin field";
  if (manifest.version !== version)
    return `CLI manifest version ${manifest.version} != release version ${version}`;
  const leaked = Object.entries(manifest.dependencies ?? {}).filter(([, v]) =>
    v.startsWith("workspace:"),
  );
  if (leaked.length)
    return `workspace:* deps leaked into publish manifest: ${leaked.map(([k]) => k).join(", ")}`;
  return null;
}

/** What a publish needs from the outside world. The tests replace each one. */
export interface PublishDeps {
  npm: NpmRunner;
  build: () => void;
  readManifest: () => PublishManifest;
  log: (line: string) => void;
}

const defaultDeps: PublishDeps = {
  npm: runNpm,
  build: buildCliBundle,
  readManifest: () =>
    JSON.parse(
      readFileSync(join(DIST_DIR, "package.json"), "utf8"),
    ) as PublishManifest,
  log: (line) => console.log(line),
};

export type PublishOutcome = "published" | "skipped" | "no-token";

/**
 * Publish `version` under `latest` unless npm already holds it or a newer
 * version, then make sure `latest` names the newest version npm holds.
 */
export async function publishCliToNpm(
  version: string,
  deps: PublishDeps = defaultDeps,
): Promise<PublishOutcome> {
  const cfg = npmCfg();
  if (!cfg) return "no-token";
  const { npm, log } = deps;

  // A user config that reads the token from the environment, so the token
  // itself is never written to disk. It lives outside the package directory,
  // so it can never be packed into the tarball.
  const configDir = mkdtempSync(join(tmpdir(), "oxagen-npm-"));
  const userconfig = join(configDir, "npmrc");
  writeFileSync(userconfig, "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n");
  const authed = { env: { ...env, NPM_TOKEN: cfg.token } };
  const auth = ["--userconfig", userconfig];

  try {
    log(kleur.bold("\n  npm CLI publish:"));
    const before = readRegistryState(npm);
    const plan = planPublish(before, version);
    if (!plan.publish) {
      log(kleur.dim(`    ${plan.reason}; nothing to publish`));
      return "skipped";
    }

    deps.build();
    log(kleur.green("    ✓ standalone CLI bundle built"));
    const problem = manifestProblem(deps.readManifest(), version);
    if (problem) throw new Error(problem);

    // access:public lives in the manifest's publishConfig. npm 11 refuses a
    // prerelease such as a build of main without an explicit tag.
    log(kleur.dim("    publishing to npm registry..."));
    try {
      npm(["publish", "--tag", "latest", ...auth], {
        cwd: DIST_DIR,
        ...authed,
      });
    } catch (err) {
      // Another run may have published this version since the check above.
      if (npmVersionExists(version, npm)) {
        log(kleur.dim(`    another run published ${version} first`));
        return "skipped";
      }
      throw err;
    }
    log(kleur.green(`    ✓ ${CLI_PACKAGE}@${version} published to npm`));

    // The registry can lag a publish by a few seconds, so count this version
    // in even when the read below does not list it yet.
    const after = readRegistryState(npm);
    const fix = latestCorrection({
      versions: [...new Set([...after.versions, version])],
      latest: after.latest,
    });
    if (fix !== null) {
      npm(["dist-tag", "add", `${CLI_PACKAGE}@${fix}`, "latest", ...auth], {
        cwd: ROOT,
        ...authed,
      });
      log(kleur.yellow(`    latest named ${after.latest}; moved it to ${fix}`));
    }
    return "published";
  } catch (err) {
    throw new Error(
      `npm publish failed: ${formatError(err)}. ` +
        `Check that NPM_TOKEN is current and can write ${CLI_PACKAGE}; packages/config/src/ci-registry.ts says how to replace it.`,
    );
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
