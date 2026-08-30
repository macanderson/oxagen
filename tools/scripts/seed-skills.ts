#!/usr/bin/env tsx
/**
 * seed-skills.ts — kept as an alias; `pnpm db:backfill-workspace-seeds` is the
 * canonical name.
 *
 * Skills belong to a workspace. The browse query reads them by a real
 * (orgId, workspaceId) pair, so a skill row has to be written per workspace to
 * be visible to anyone. Two paths write them:
 *   1. The workspace-creation Server Actions (new-workspace/actions.ts and
 *      (onboarding)/new-organization/actions.ts) — every new workspace gets
 *      builtin skill copies on creation.
 *   2. backfill-workspace-seeds.ts — covers workspaces created before those
 *      actions wrote skills.
 *
 * This script walks every workspace and calls the same per-workspace seeder,
 * so `pnpm db:seed-skills` and the backfill do the same thing.
 *
 * Run via:
 *   pnpm db:seed-skills            (dry-run by default)
 *   pnpm db:seed-skills -- --apply (writes per-workspace skill rows)
 */

import { createInterface } from "node:readline";
import { URL } from "node:url";
import kleur from "kleur";
import { requireEnv } from "@oxagen/config/env";
import { formatError } from "./lib/format-error";
import { db, closeDatabase, schema } from "@oxagen/database";
import { seedWorkspaceDefaultSkillsSystem } from "@oxagen/handlers/skill-workspace-seed";

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply");

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitizeUrl(raw: string): { host: string; database: string } {
  try {
    const u = new URL(raw);
    return {
      host: `${u.hostname}:${u.port || "5432"}`,
      database: u.pathname.replace(/^\//, "") || "(default)",
    };
  } catch {
    return { host: "(unparseable)", database: "(unparseable)" };
  }
}

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|::1)(:\d+)?$/.test(host);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const start = Date.now();

  const env = requireEnv(["DATABASE_URL"]);
  const { host, database } = sanitizeUrl(env.DATABASE_URL);

  console.log(
    kleur.cyan(
      "┌───────────────────────────────────────────────────────────────┐",
    ),
  );
  console.log(
    kleur.cyan(
      "│   seed-skills — per-workspace builtin skill seeder (backfill) │",
    ),
  );
  console.log(
    kleur.cyan(
      "└───────────────────────────────────────────────────────────────┘",
    ),
  );
  console.log();
  console.log(
    kleur.yellow("NOTE: Seeds builtin skills into every workspace (see"),
  );
  console.log(
    kleur.yellow(
      "      skill-workspace-seed.ts). `pnpm db:backfill-workspace-seeds`",
    ),
  );
  console.log(kleur.yellow("      is the canonical name for this command."));
  console.log();
  console.log(`  Target host  : ${kleur.yellow(host)}`);
  console.log(`  Database     : ${kleur.yellow(database)}`);
  console.log(
    `  Mode         : ${DRY_RUN ? kleur.blue("DRY RUN (read-only)") : kleur.red("APPLY (will write)")}`,
  );
  console.log();

  if (!DRY_RUN && !isLocalHost(host)) {
    console.log(kleur.red("  ⚠  Non-local database detected in --apply mode."));
    const ok = await confirm(
      "  Proceed with write to production database? [y/N] ",
    );
    if (!ok) {
      console.log(kleur.yellow("  Aborted."));
      process.exit(0);
    }
    console.log();
  }

  const d = db();

  // Enumerate all workspaces and seed skills for each.
  const allWorkspaces = await d
    .select({
      id: schema.workspaces.id,
      orgId: schema.workspaces.orgId,
      name: schema.workspaces.name,
    })
    .from(schema.workspaces)
    .orderBy(schema.workspaces.createdAt);

  console.log(
    kleur.cyan(
      `[seed-skills] ${allWorkspaces.length} workspace(s) found — seeding builtin skills per-workspace…`,
    ),
  );
  console.log();

  let totalInserted = 0;
  let totalScanned = 0;
  let failed = 0;

  for (const ws of allWorkspaces) {
    if (DRY_RUN) {
      console.log(
        kleur.blue(
          `  [dry-run] ${ws.name} (${ws.id}) org=${ws.orgId} — WOULD seed builtin skills`,
        ),
      );
      continue;
    }

    try {
      const result = await seedWorkspaceDefaultSkillsSystem({
        orgId: ws.orgId,
        workspaceId: ws.id,
      });
      totalScanned += result.scanned;
      totalInserted += result.inserted;
      console.log(
        kleur.green(
          `  [seeded] ${ws.name} (${ws.id}) inserted=${result.inserted}/${result.scanned}`,
        ),
      );
    } catch (err: unknown) {
      failed++;
      console.log(
        kleur.red(
          `  [fail] ${ws.name} (${ws.id}) org=${ws.orgId} — ${formatError(err)}`,
        ),
      );
    }
  }

  const totalMs = Date.now() - start;

  console.log();
  console.log(
    kleur.cyan(
      "─────────────────────────────────────────────────────────────────",
    ),
  );
  console.log(kleur.cyan(`[seed-skills] Summary (${totalMs}ms)`));
  console.log(`  Workspaces scanned  : ${allWorkspaces.length}`);
  if (!DRY_RUN) {
    console.log(`  Templates scanned   : ${totalScanned}`);
    console.log(
      `  Skills inserted     : ${totalInserted > 0 ? kleur.green(String(totalInserted)) : kleur.dim("0")}`,
    );
    console.log(
      `  Failed workspaces   : ${failed > 0 ? kleur.red(String(failed)) : kleur.dim("0")}`,
    );
  } else {
    console.log(kleur.blue("  (dry-run — no writes made)"));
  }

  if (DRY_RUN) {
    console.log();
    console.log(
      kleur.blue(
        "[seed-skills] This was a dry-run. Re-run with --apply to write.",
      ),
    );
  }

  await closeDatabase();

  if (failed > 0) {
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(kleur.red("[seed-skills] Fatal:"), formatError(err));
    process.exit(1);
  });
