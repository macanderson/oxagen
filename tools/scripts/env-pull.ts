#!/usr/bin/env tsx
/**
 * Pulls `.env.local` from Vercel's Development environment for every linked
 * project in the monorepo. Vercel is the source of truth — this script just
 * materialises whatever's currently configured in
 * dashboard.vercel.com → 02beta → <project> → Settings → Environment Variables.
 *
 * Run `pnpm env:pull` after Vercel env edits to refresh local secrets.
 */
import { execa } from "execa";
import kleur from "kleur";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());
const VERCEL_SCOPE = "02beta";
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
  await execa(
    "vercel",
    [
      "env",
      "pull",
      ".env.local",
      "--environment=development",
      "--yes",
      `--scope=${VERCEL_SCOPE}`,
    ],
    { cwd: target.dir, stdio: "inherit" },
  );
}

async function main(): Promise<void> {
  for (const t of TARGETS) await pull(t);
  console.log(kleur.green("[env-pull] done"));
}

main().catch((err) => {
  console.error(kleur.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
