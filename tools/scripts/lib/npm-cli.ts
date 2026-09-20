/**
 * Publish `@oxagen/cli` to npm from the tree, as a single-file bundle with a
 * clean manifest. Shared by `release.ts` (publish as part of the bump) and
 * `release-publish.ts` (publish once the tagged build is green).
 *
 * Publishing apps/cli/package.json directly is BROKEN: its deps carry
 * `@oxagen/*: workspace:*` (unpublished, protocol leaks) and its bin shebang is
 * `tsx`, so `npm i -g @oxagen/cli` fails in a clean env. See
 * apps/cli/scripts/bundle.mjs and prepare-standalone-publish.mjs for the why.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { env } from "node:process";
import kleur from "kleur";
import { formatError } from "./format-error";

const ROOT = resolve(import.meta.dirname, "../../..");

/** Env values pasted into a Vercel dashboard arrive double-quoted; strip one pair. */
function deQuote(v: string | undefined): string {
  if (!v) return "";
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"')
    ? v.slice(1, -1)
    : v;
}

/** True when `@oxagen/cli@version` is already on the registry. */
export function npmVersionExists(version: string): boolean {
  try {
    const out = execFileSync(
      "npm",
      ["view", `@oxagen/cli@${version}`, "version", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out !== "" && out !== "[]";
  } catch {
    return false;
  }
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

export async function publishCliToNpm(version: string): Promise<void> {
  const cfg = npmCfg();
  if (!cfg) return;

  try {
    console.log(kleur.bold("\n  npm CLI publish:"));
    // Build the standalone single-file bundle + clean publish manifest.
    buildCliBundle();
    console.log(kleur.green("    ✓ standalone CLI bundle built"));

    // Validate the generated publish manifest (NOT apps/cli/package.json, which
    // is unpublishable). Guard against the historical failure modes: private,
    // missing bin, version drift, and leaked workspace:* deps.
    const distDir = join(ROOT, "apps/cli/dist-standalone");
    const manifest = JSON.parse(
      readFileSync(join(distDir, "package.json"), "utf8"),
    ) as {
      name?: string;
      version?: string;
      private?: boolean;
      bin?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    if (manifest.private)
      throw new Error('CLI manifest has "private": true — cannot publish');
    if (!manifest.bin || Object.keys(manifest.bin).length === 0)
      throw new Error("CLI manifest missing bin field");
    if (manifest.version !== version)
      throw new Error(
        `CLI manifest version ${manifest.version} != release version ${version}`,
      );
    const leaked = Object.entries(manifest.dependencies ?? {}).filter(([, v]) =>
      v.startsWith("workspace:"),
    );
    if (leaked.length)
      throw new Error(
        `workspace:* deps leaked into publish manifest: ${leaked.map(([k]) => k).join(", ")}`,
      );

    // npm reads the auth token from .npmrc; write one that pulls NPM_TOKEN from
    // the environment. Never published — not in the manifest `files`, and npm
    // always excludes .npmrc from the tarball.
    writeFileSync(
      join(distDir, ".npmrc"),
      "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
    );

    // Publish the bundle. access:public lives in the manifest publishConfig.
    console.log(kleur.dim("    publishing to npm registry..."));
    execFileSync("npm", ["publish"], {
      cwd: distDir,
      stdio: "pipe",
      env: { ...env, NPM_TOKEN: cfg.token },
      maxBuffer: 64 * 1024 * 1024,
    });

    console.log(kleur.green(`    ✓ @oxagen/cli v${version} published to npm`));
  } catch (err) {
    throw new Error(
      `npm publish failed: ${formatError(err)}. ` +
        `Ensure NPM_TOKEN is set and the CLI package is not marked as private.`,
    );
  }
}
