#!/usr/bin/env tsx
/**
 * backfill-workspace-seeds.ts
 *
 * Idempotent backfill: seeds the default MCP registry, first-party capability
 * packs, and builtin skill templates into every existing workspace that was
 * created before the three seeders were wired into the workspace-creation Server
 * Actions (new-workspace/actions.ts and (onboarding)/new-organization/actions.ts).
 *
 * Workspaces that already have all seed data are skipped automatically because
 * each seeder is idempotent:
 *   - workspace-registry-seed   → select-first; skips insert when row exists.
 *   - workspace-capability-seed → ON CONFLICT DO UPDATE; safe to re-run.
 *   - skill-workspace-seed      → select-first per slug; skips existing rows.
 *
 * Algorithm:
 *   1. Enumerate all (orgId, workspaceId) pairs from the workspaces table.
 *   2. For each workspace, call the three *System seeders in sequence.
 *   3. Continue on per-workspace error so one bad workspace does not abort the rest.
 *
 * Safety:
 *   - Defaults to --dry-run; pass --apply to write.
 *   - Prints the sanitized target host + database at startup.
 *   - Requires confirmation before --apply on a non-local host.
 *   - All writes are idempotent — safe to re-run.
 *
 * Usage:
 *   pnpm db:backfill-workspace-seeds              # dry-run (safe, read-only)
 *   pnpm db:backfill-workspace-seeds -- --apply   # write changes
 *
 * Env:
 *   DATABASE_URL — required. Sourced from .env.local via --env-file-if-exists.
 *   tsx --env-file does NOT override a shell-set DATABASE_URL (see [[prod-db-ops]]).
 *   Always double-check the printed target host before running --apply.
 *
 * Instrumentation:
 *   Prints total workspaces scanned, seeded, and failed with per-workspace timing.
 */

import { createInterface } from "node:readline";
import { URL } from "node:url";
import kleur from "kleur";
import { requireEnv } from "@oxagen/config/env";
import { formatError } from "./lib/format-error";
import { db, closeDatabase, schema } from "@oxagen/database";
import { seedWorkspaceDefaultRegistrySystem } from "@oxagen/handlers/workspace-registry-seed";
import { seedWorkspaceDefaultCapabilitiesSystem } from "@oxagen/handlers/workspace-capability-seed";
import { seedWorkspaceDefaultSkillsSystem } from "@oxagen/handlers/skill-workspace-seed";
import { seedWorkspaceDefaultEnvironmentSystem } from "@oxagen/handlers/workspace-environment-seed";

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

// ── Result tracking ───────────────────────────────────────────────────────────

interface WorkspaceResult {
  orgId: string;
  workspaceId: string;
  workspaceName: string;
  status: "seeded" | "failed" | "dry-run";
  durationMs?: number;
  registryId?: string;
  skillsInserted?: number;
  error?: string;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const start = Date.now();

  const env = requireEnv(["DATABASE_URL"]);
  const { host, database } = sanitizeUrl(env.DATABASE_URL);

  console.log(
    kleur.cyan(
      "┌─────────────────────────────────────────────────────────────────┐",
    ),
  );
  console.log(
    kleur.cyan(
      "│   backfill-workspace-seeds — registry + capabilities + skills   │",
    ),
  );
  console.log(
    kleur.cyan(
      "└─────────────────────────────────────────────────────────────────┘",
    ),
  );
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

  // ── 1. Enumerate all workspaces ──────────────────────────────────────────────
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
      `[backfill-workspace-seeds] ${allWorkspaces.length} workspace(s) found — seeding registry + capabilities + skills…`,
    ),
  );
  console.log();

  const results: WorkspaceResult[] = [];

  for (const ws of allWorkspaces) {
    const wsStart = Date.now();

    if (DRY_RUN) {
      console.log(
        kleur.blue(
          `  [dry-run] ${ws.name} (${ws.id}) org=${ws.orgId} — WOULD seed registry + 4 capability packs + builtin skills`,
        ),
      );
      results.push({
        orgId: ws.orgId,
        workspaceId: ws.id,
        workspaceName: ws.name,
        status: "dry-run",
        durationMs: Date.now() - wsStart,
      });
      continue;
    }

    try {
      // 2a. Default MCP registry
      const registryId = await seedWorkspaceDefaultRegistrySystem({
        orgId: ws.orgId,
        workspaceId: ws.id,
      });

      // 2b. Default capability packs
      await seedWorkspaceDefaultCapabilitiesSystem({
        orgId: ws.orgId,
        workspaceId: ws.id,
      });

      // 2c. Default builtin skills
      const skillResult = await seedWorkspaceDefaultSkillsSystem({
        orgId: ws.orgId,
        workspaceId: ws.id,
      });

      // 2d. Default environment (Spec §15)
      await seedWorkspaceDefaultEnvironmentSystem({
        orgId: ws.orgId,
        workspaceId: ws.id,
      });

      const durationMs = Date.now() - wsStart;
      console.log(
        kleur.green(
          `  [seeded] ${ws.name} (${ws.id}) org=${ws.orgId} registry=${registryId} skills.inserted=${skillResult.inserted}/${skillResult.scanned} [${durationMs}ms]`,
        ),
      );
      results.push({
        orgId: ws.orgId,
        workspaceId: ws.id,
        workspaceName: ws.name,
        status: "seeded",
        durationMs,
        registryId,
        skillsInserted: skillResult.inserted,
      });
    } catch (err: unknown) {
      const msg = formatError(err);
      console.log(
        kleur.red(`  [fail] ${ws.name} (${ws.id}) org=${ws.orgId} — ${msg}`),
      );
      results.push({
        orgId: ws.orgId,
        workspaceId: ws.id,
        workspaceName: ws.name,
        status: "failed",
        durationMs: Date.now() - wsStart,
        error: msg,
      });
    }
  }

  // ── 3. Summary ────────────────────────────────────────────────────────────────
  const scanned = results.length;
  const seeded = results.filter((r) => r.status === "seeded").length;
  const dryRun = results.filter((r) => r.status === "dry-run").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const totalMs = Date.now() - start;

  console.log();
  console.log(
    kleur.cyan(
      "─────────────────────────────────────────────────────────────────────",
    ),
  );
  console.log(kleur.cyan(`[backfill-workspace-seeds] Summary (${totalMs}ms)`));
  console.log(`  Workspaces scanned : ${scanned}`);
  if (DRY_RUN) {
    console.log(`  Would seed         : ${kleur.blue(String(dryRun))}`);
  } else {
    console.log(
      `  Seeded             : ${seeded > 0 ? kleur.green(String(seeded)) : kleur.dim("0")}`,
    );
  }
  console.log(
    `  Failed             : ${failed > 0 ? kleur.red(String(failed)) : kleur.dim("0")}`,
  );

  if (failed > 0) {
    console.log();
    console.log(kleur.red("[backfill-workspace-seeds] Failed workspaces:"));
    for (const r of results.filter((r) => r.status === "failed")) {
      console.log(
        kleur.red(`  - ws=${r.workspaceId} org=${r.orgId}: ${r.error}`),
      );
    }
  }

  if (DRY_RUN) {
    console.log();
    console.log(
      kleur.blue(
        "[backfill-workspace-seeds] This was a dry-run. Re-run with --apply to write changes.",
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
    console.error(
      kleur.red("[backfill-workspace-seeds] Fatal:"),
      formatError(err),
    );
    process.exit(1);
  });
