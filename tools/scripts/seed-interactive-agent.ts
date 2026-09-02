#!/usr/bin/env tsx
/**
 * seed-interactive-agent.ts — OXA agent-lifecycle-backend
 *
 * Ensures EVERY workspace has the built-in `qa-chat` interactive agent: a
 * published v1 with a schema-conforming config (graph access, instructions, and
 * agentTools referencing the builtin skills), status 'active', deploymentStatus
 * 'active'. This is the single agent backing both the MCP server and the in-app
 * Q&A surface — it makes the chat.stream lookup (slug "qa-chat") resolve to a
 * definition with an activeVersionId so executions are recorded (SOC 2 trail).
 *
 * Idempotent: re-running leaves already-published agents untouched and
 * reconciles any legacy qa-chat row that lacks an active version. Delegates the
 * per-workspace write to bootstrapWorkspaceAgents — the same function the
 * workspace-create transaction calls — so seed and runtime never diverge.
 *
 * Usage:
 *   pnpm db:seed-interactive-agent              # dry-run (read-only)
 *   pnpm db:seed-interactive-agent -- --apply   # write changes
 *
 * Env:
 *   DATABASE_URL — required. Sourced from .env.local via --env-file-if-exists.
 *   tsx --env-file does NOT override a shell-set DATABASE_URL — `unset
 *   DATABASE_URL` to force local targeting. Always confirm the printed host.
 */

import { createInterface } from "node:readline";
import { URL } from "node:url";
import kleur from "kleur";
import { requireEnv } from "@oxagen/config/env";
import { db, closeDatabase, schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { bootstrapWorkspaceAgents } from "@oxagen/handlers";
import { INTERACTIVE_AGENT_SLUG } from "@oxagen/oxagen/interactive-agent";
import { formatError } from "./lib/format-error";

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply");

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

interface WorkspaceResult {
  workspaceId: string;
  slug: string;
  status: "seeded" | "skipped" | "failed" | "dry-run";
  error?: string;
}

async function main(): Promise<void> {
  const start = Date.now();
  const env = requireEnv(["DATABASE_URL"]);
  const { host, database } = sanitizeUrl(env.DATABASE_URL);

  console.log(kleur.cyan("[seed-interactive-agent] qa-chat seeder"));
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
      await closeDatabase();
      process.exit(0);
    }
    console.log();
  }

  const d = db();

  const allWorkspaces = await d
    .select({
      id: schema.workspaces.id,
      orgId: schema.workspaces.orgId,
      slug: schema.workspaces.slug,
      createdByUserId: schema.workspaces.createdByUserId,
    })
    .from(schema.workspaces)
    .orderBy(schema.workspaces.createdAt);

  console.log(
    kleur.cyan(
      `[seed-interactive-agent] ${allWorkspaces.length} workspace(s) found`,
    ),
  );
  console.log();

  const results: WorkspaceResult[] = [];

  for (const ws of allWorkspaces) {
    // Skip workspaces whose qa-chat is already published (has an active version).
    const [existing] = await d
      .select({ activeVersionId: schema.agents.activeVersionId })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, ws.id),
          eq(schema.agents.slug, INTERACTIVE_AGENT_SLUG),
        ),
      )
      .limit(1);

    if (existing?.activeVersionId) {
      results.push({ workspaceId: ws.id, slug: ws.slug, status: "skipped" });
      console.log(kleur.dim(`  [skip] ${ws.slug} — qa-chat already published`));
      continue;
    }

    // Resolve a user to attribute the seed write to: the workspace owner, else
    // its creator. createdByUserId is the durable fallback.
    const [owner] = await d
      .select({ userId: schema.workspaceUsers.userId })
      .from(schema.workspaceUsers)
      .where(
        and(
          eq(schema.workspaceUsers.workspaceId, ws.id),
          eq(schema.workspaceUsers.role, "owner"),
        ),
      )
      .limit(1);

    const userId = owner?.userId ?? ws.createdByUserId;
    if (!userId) {
      const msg = "no owner or creator user to attribute the seed write to";
      results.push({
        workspaceId: ws.id,
        slug: ws.slug,
        status: "failed",
        error: msg,
      });
      console.log(kleur.red(`  [fail] ${ws.slug} — ${msg}`));
      continue;
    }

    if (DRY_RUN) {
      results.push({ workspaceId: ws.id, slug: ws.slug, status: "dry-run" });
      console.log(kleur.blue(`  [dry-run] ${ws.slug} — WOULD seed qa-chat`));
      continue;
    }

    try {
      await d.transaction(async (tx) => {
        await bootstrapWorkspaceAgents({
          workspaceId: ws.id,
          orgId: ws.orgId,
          userId,
          tx,
        });
      });
      results.push({ workspaceId: ws.id, slug: ws.slug, status: "seeded" });
      console.log(kleur.green(`  [seeded] ${ws.slug} — qa-chat published`));
    } catch (err: unknown) {
      const msg = formatError(err);
      results.push({
        workspaceId: ws.id,
        slug: ws.slug,
        status: "failed",
        error: msg,
      });
      console.log(kleur.red(`  [fail] ${ws.slug} — ${msg}`));
    }
  }

  const seeded = results.filter((r) => r.status === "seeded").length;
  const dryRun = results.filter((r) => r.status === "dry-run").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;

  console.log();
  console.log(
    kleur.cyan(`[seed-interactive-agent] Summary (${Date.now() - start}ms)`),
  );
  console.log(`  Workspaces scanned : ${results.length}`);
  if (DRY_RUN) {
    console.log(`  Would seed         : ${kleur.blue(String(dryRun))}`);
  } else {
    console.log(
      `  Seeded             : ${seeded > 0 ? kleur.green(String(seeded)) : kleur.dim("0")}`,
    );
  }
  console.log(`  Skipped (ok)       : ${kleur.dim(String(skipped))}`);
  console.log(
    `  Failed             : ${failed > 0 ? kleur.red(String(failed)) : kleur.dim("0")}`,
  );

  await closeDatabase();
  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(
      kleur.red("[seed-interactive-agent] Fatal:"),
      formatError(err),
    );
    process.exit(1);
  });
