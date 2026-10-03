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
 * `X.Y.(Z+1)-N` both reach `latest`, the same rule the downloads host follows
 * for its `latest/` links. A version older than the newest one on npm is not
 * published, and after each publish `latest` is checked again, because two
 * runs can publish at once and the slower one would otherwise leave `latest`
 * on the older version.
 *
 * A caller that passes a `check` publishes under the `candidate` tag instead,
 * and `latest` moves to a version only after the check passes for it. npm can
 * take minutes to serve a new tarball, and until then `npm i -g @oxagen/cli`
 * would fetch a file that answers 404 (#5203).
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

/**
 * The dist-tag a checked publish goes out under, before `latest` moves to it.
 * Two runs can each move it, which does no harm, because the check reads the
 * version's own tarball URL and never this tag.
 */
export const CANDIDATE_TAG = "candidate";

/**
 * Answers whether npm serves `version` and the CLI in it runs. It may take
 * minutes, because npm can take that long to serve a new tarball.
 */
export type CliCheck = (version: string) => Promise<boolean>;

/** Where npm serves the CLI's tarball for `version`. */
export function tarballUrl(version: string): string {
  return `https://registry.npmjs.org/${CLI_PACKAGE}/-/cli-${version}.tgz`;
}

/**
 * Whether npm refused a publish because the version is already there. npm's
 * reads can trail a publish by minutes, so a run can miss a version another
 * run just published, and this refusal is the first sign of it.
 */
export function isAlreadyPublished(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /cannot publish over the previously published version/i.test(text);
}

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
  /**
   * When set, the publish goes out under CANDIDATE_TAG, and `latest` moves to
   * a version only once this answers true for it. When unset, the publish
   * goes out under `latest`.
   */
  check?: CliCheck;
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

const TOKEN_HINT = `Check that NPM_TOKEN is current and can write ${CLI_PACKAGE}. packages/config/src/ci-registry.ts says how to replace it.`;

/**
 * Whether pointing `latest` at `candidate` moves it forward from `current`.
 * A `current` of a shape this code cannot order gives way, because it is not
 * a version this pipeline published.
 */
export function movesLatestForward(
  current: string | null,
  candidate: string,
): boolean {
  if (current === null) return true;
  try {
    return compareVersions(candidate, current) > 0;
  } catch {
    return true;
  }
}

/**
 * Publish `version` unless npm already holds it or a newer version, then
 * make sure `latest` names the newest version npm holds. With `check` set,
 * `latest` moves only to a version that passes the check, and a version that
 * fails it throws with `latest` left where it was.
 */
export async function publishCliToNpm(
  version: string,
  overrides: Partial<PublishDeps> = {},
): Promise<PublishOutcome> {
  const cfg = npmCfg();
  if (!cfg) return "no-token";
  const { npm, log, build, readManifest, check } = {
    ...defaultDeps,
    ...overrides,
  };

  // A user config that reads the token from the environment, so the token
  // itself is never written to disk. It lives outside the package directory,
  // so it can never be packed into the tarball.
  const configDir = mkdtempSync(join(tmpdir(), "oxagen-npm-"));
  const userconfig = join(configDir, "npmrc");
  writeFileSync(userconfig, "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n");
  const authed = { env: { ...env, NPM_TOKEN: cfg.token } };
  const auth = ["--userconfig", userconfig];

  /**
   * Point `latest` at `target` when that moves it forward. `latest` is read
   * right before the write, because a check can take minutes and another run
   * may have moved `latest` past `target` in that time.
   */
  const moveLatestTo = (target: string): void => {
    const current = readRegistryState(npm).latest;
    if (!movesLatestForward(current, target)) return;
    try {
      npm(["dist-tag", "add", `${CLI_PACKAGE}@${target}`, "latest", ...auth], {
        cwd: ROOT,
        ...authed,
      });
    } catch (err) {
      throw new Error(
        `npm dist-tag add ${CLI_PACKAGE}@${target} latest failed: ${formatError(err)}. ${TOKEN_HINT}`,
      );
    }
    log(kleur.yellow(`    latest named ${current}; moved it to ${target}`));
  };

  /**
   * Point `latest` at the newest version npm holds, counting `known` in
   * case the registry has not listed it yet. A read can lag a publish by a
   * few seconds and show an older `latest`, so `moveLatestTo` reads it again
   * and only ever moves it forward. With `check` set, the newest version
   * must pass the check first.
   */
  const repairLatest = async (known: string[]): Promise<void> => {
    const seen = readRegistryState(npm);
    const fix = latestCorrection({
      versions: [...new Set([...seen.versions, ...known])],
      latest: seen.latest,
    });
    if (fix === null) return;
    if (check) {
      log(
        kleur.dim(`    checking ${CLI_PACKAGE}@${fix} before latest moves to it`),
      );
      if (!(await check(fix))) {
        const stays = seen.latest ?? "no version";
        throw new Error(
          `${CLI_PACKAGE}@${fix} is on npm, but it failed the check, so latest still names ${stays} and \`npm install -g ${CLI_PACKAGE}\` installs ${stays}. Run npm.yml again to check ${fix} once more. To move latest by hand, first make sure \`npx ${tarballUrl(fix)} --version\` prints ${fix}, then run \`npm dist-tag add ${CLI_PACKAGE}@${fix} latest\`.`,
        );
      }
    }
    moveLatestTo(fix);
  };

  try {
    log(kleur.bold("\n  npm CLI publish:"));
    const plan = planPublish(readRegistryState(npm), version);
    if (!plan.publish) {
      log(kleur.dim(`    ${plan.reason}; nothing to publish`));
      // A run that publishes nothing still repairs a `latest` an earlier
      // race or a failed check left behind, so the daily run can fix it.
      await repairLatest([]);
      return "skipped";
    }

    build();
    log(kleur.green("    ✓ standalone CLI bundle built"));
    const problem = manifestProblem(readManifest(), version);
    if (problem) throw new Error(problem);

    // access:public lives in the manifest's publishConfig. npm 11 refuses a
    // prerelease such as a build of main without an explicit tag.
    const tag = check ? CANDIDATE_TAG : "latest";
    log(kleur.dim(`    publishing to npm registry under ${tag}...`));
    try {
      npm(["publish", "--tag", tag, ...auth], {
        cwd: DIST_DIR,
        ...authed,
      });
    } catch (err) {
      // Another run may have published this version since the check above.
      if (isAlreadyPublished(err) || npmVersionExists(version, npm)) {
        log(kleur.dim(`    another run published ${version} first`));
        await repairLatest([version]);
        return "skipped";
      }
      throw new Error(`npm publish failed: ${formatError(err)}. ${TOKEN_HINT}`);
    }
    log(
      kleur.green(`    ✓ ${CLI_PACKAGE}@${version} published to npm under ${tag}`),
    );
    await repairLatest([version]);
    return "published";
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
