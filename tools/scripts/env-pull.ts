#!/usr/bin/env tsx
/**
 * Pulls `.env.local` from Vercel's Development environment for every linked
 * project in the monorepo. Vercel is the source of truth — this script just
 * materialises whatever's currently configured in
 * dashboard.vercel.com → <team> → <project> → Settings → Environment Variables.
 *
 * Run `pnpm env:pull` after Vercel env edits to refresh local secrets.
 *
 * Team scope: set `VERCEL_TEAM_SLUG` to pass `--scope` explicitly (handy when
 * your CLI default team differs). When unset, the Vercel CLI resolves the team
 * from each project's linked `.vercel/project.json`, so the pull still works —
 * we deliberately don't hardcode a team slug here.
 */
import { execa } from "execa";
import kleur from "kleur";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatError } from "./lib/format-error";
import { collapseRedundantQuotes } from "./lib/normalize-env-file";
import { ENV_TARGETS } from "./lib/env-targets";

const ROOT = resolve(process.cwd());
const VERCEL_TEAM_SLUG = process.env.VERCEL_TEAM_SLUG?.trim();

async function pull(target: { name: string; dir: string }): Promise<void> {
  if (!existsSync(resolve(target.dir, ".vercel/project.json"))) {
    console.log(kleur.yellow(`[env-pull] ${target.name} not linked, skipping`));
    return;
  }
  console.log(kleur.cyan(`[env-pull] ${target.name}`));
  const args = [
    "env",
    "pull",
    ".env.local",
    "--environment=development",
    "--yes",
  ];
  if (VERCEL_TEAM_SLUG) args.push(`--scope=${VERCEL_TEAM_SLUG}`);
  await execa("vercel", args, { cwd: target.dir, stdio: "inherit" });

  // Some Vercel projects store values with literal surrounding quotes, which
  // `vercel env pull` re-wraps into `KEY=""value""` — dotenv then reads that as
  // an empty string and consumers that validate the value (the api's
  // requireEnv on BETTER_AUTH_*/NODE_ENV) crash on boot. Heal it in place so
  // every pull self-corrects regardless of the upstream quoting.
  const envFile = resolve(target.dir, ".env.local");
  const { content, collapsed } = collapseRedundantQuotes(
    readFileSync(envFile, "utf8"),
  );
  if (collapsed > 0) {
    writeFileSync(envFile, content);
    console.log(
      kleur.yellow(
        `[env-pull] ${target.name}: healed ${collapsed} doubly-quoted value(s)`,
      ),
    );
  }
}

async function main(): Promise<void> {
  for (const t of ENV_TARGETS) {
    await pull({ name: t.name, dir: resolve(ROOT, t.dir) });
  }
  console.log(kleur.green("[env-pull] done"));
}

main().catch((err) => {
  console.error(kleur.red(formatError(err)));
  process.exit(1);
});
