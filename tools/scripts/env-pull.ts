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
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatError } from "./lib/format-error";

const ROOT = resolve(process.cwd());
const VERCEL_TEAM_SLUG = process.env.VERCEL_TEAM_SLUG?.trim();
const TARGETS = [
  { name: "root", dir: ROOT },
  { name: "@oxagen/app", dir: resolve(ROOT, "apps/app") },
  { name: "@oxagen/website", dir: resolve(ROOT, "apps/website") },
  { name: "@oxagen/api", dir: resolve(ROOT, "apps/api") },
  { name: "@oxagen/mcp", dir: resolve(ROOT, "apps/mcp") },
];

async function pull(target: { name: string; dir: string }): Promise<void> {
  if (!existsSync(resolve(target.dir, ".vercel/project.json"))) {
    console.log(kleur.yellow(`[env-pull] ${target.name} not linked, skipping`));
    return;
  }
  console.log(kleur.cyan(`[env-pull] ${target.name}`));
  const args = ["env", "pull", ".env.local", "--environment=development", "--yes"];
  if (VERCEL_TEAM_SLUG) args.push(`--scope=${VERCEL_TEAM_SLUG}`);
  await execa("vercel", args, { cwd: target.dir, stdio: "inherit" });
}

async function main(): Promise<void> {
  for (const t of TARGETS) await pull(t);
  console.log(kleur.green("[env-pull] done"));
}

main().catch((err) => {
  console.error(kleur.red(formatError(err)));
  process.exit(1);
});
