#!/usr/bin/env tsx
/**
 * backfill-workspace-capabilities.ts — OXA-1739
 *
 * Idempotent backfill: seeds the four default first-party agent_capability packs
 * (oxagen/media-video, oxagen/media-image, oxagen/media-svg, oxagen/documents)
 * into every existing workspace that was created before workspace-capability-seed
 * was wired into workspace.create.
 *
 * Workspaces that already have all four packs installed are skipped. Workspaces
 * that have some but not all packs will have only the missing ones inserted.
 * Because seedWorkspaceDefaultCapabilities uses ON CONFLICT DO UPDATE, it is safe
 * to run against already-seeded workspaces (updatedAt is touched, no duplicates).
 *
 * Algorithm:
 *   1. Enumerate all (orgId, workspaceId) pairs from the workspaces table.
 *   2. For each workspace, call seedWorkspaceDefaultCapabilities (idempotent).
 *   3. Collect per-workspace results; continue on error so one bad workspace
 *      does not abort the rest.
 *
 * Safety:
 *   - Defaults to --dry-run; pass --apply to write.
 *   - Prints the sanitized target host + database at startup.
 *   - Requires confirmation before --apply on a non-local host.
 *   - All writes are ON CONFLICT DO UPDATE — safe to re-run.
 *
 * Usage:
 *   pnpm db:backfill-capabilities              # dry-run (safe, read-only)
 *   pnpm db:backfill-capabilities -- --apply   # write changes
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
import { seedWorkspaceDefaultCapabilities } from "@oxagen/handlers/workspace-capability-seed";

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
  status: "seeded" | "failed" | "dry-run";
  durationMs?: number;
  error?: string;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const start = Date.now();

  const env = requireEnv(["DATABASE_URL"]);
  const { host, database } = sanitizeUrl(env.DATABASE_URL);

  console.log(
    kleur.cyan(
      "┌─────────────────────────────────────────────────────────────┐",
    ),
  );
  console.log(
    kleur.cyan(
      "│    backfill-workspace-capabilities — OXA-1739 backfill      │",
    ),
  );
  console.log(
    kleur.cyan(
      "└─────────────────────────────────────────────────────────────┘",
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
      `[backfill-capabilities] ${allWorkspaces.length} workspace(s) found — seeding capability packs…`,
    ),
  );
  console.log();

  const results: WorkspaceResult[] = [];

  for (const ws of allWorkspaces) {
    const wsStart = Date.now();

    if (DRY_RUN) {
      console.log(
        kleur.blue(
          `  [dry-run] ${ws.name} (${ws.id}) org=${ws.orgId} — WOULD seed 4 capability packs`,
        ),
      );
      results.push({
        orgId: ws.orgId,
        workspaceId: ws.id,
        status: "dry-run",
        durationMs: Date.now() - wsStart,
      });
      continue;
    }

    try {
      await seedWorkspaceDefaultCapabilities({
        orgId: ws.orgId,
        workspaceId: ws.id,
      });

      const durationMs = Date.now() - wsStart;
      console.log(
        kleur.green(
          `  [seeded] ${ws.name} (${ws.id}) org=${ws.orgId} [${durationMs}ms]`,
        ),
      );
      results.push({
        orgId: ws.orgId,
        workspaceId: ws.id,
        status: "seeded",
        durationMs,
      });
    } catch (err: unknown) {
      const msg = formatError(err);
      console.log(
        kleur.red(`  [fail] ${ws.name} (${ws.id}) org=${ws.orgId} — ${msg}`),
      );
      results.push({
        orgId: ws.orgId,
        workspaceId: ws.id,
        status: "failed",
        durationMs: Date.now() - wsStart,
        error: msg,
      });
    }
  }

  // ── 2. Summary ────────────────────────────────────────────────────────────────
  const scanned = results.length;
  const seeded = results.filter((r) => r.status === "seeded").length;
  const dryRun = results.filter((r) => r.status === "dry-run").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const totalMs = Date.now() - start;

  console.log();
  console.log(
    kleur.cyan(
      "─────────────────────────────────────────────────────────────────",
    ),
  );
  console.log(kleur.cyan(`[backfill-capabilities] Summary (${totalMs}ms)`));
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
    console.log(kleur.red("[backfill-capabilities] Failed workspaces:"));
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
        "[backfill-capabilities] This was a dry-run. Re-run with --apply to write changes.",
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
      kleur.red("[backfill-capabilities] Fatal:"),
      formatError(err),
    );
    process.exit(1);
  });
