#!/usr/bin/env tsx
/**
 * backfill-org-iam.ts — OXA-xxxx
 *
 * Idempotent IAM backfill for orgs created before bootstrapOrgIAM() existed.
 * Orgs that were created before the IAM bootstrap was wired into
 * organization.create have no principals/roles/role_grants/assignments. With
 * IAM_ENFORCEMENT_ENABLED=true those members fall to deny-by-default on every
 * capability. This script seeds them correctly.
 *
 * Algorithm per org:
 *   1. Check whether ANY principal row already exists for this org.
 *      → If yes, skip (already seeded).
 *   2. Identify the owner: the org_users row with role = 'owner'.
 *   3. In a single Drizzle transaction: bootstrapOrgIAM(orgId, ownerUserId).
 *   4. For every non-owner member (org_users rows with role != 'owner'):
 *      provisionMemberPrincipal(orgId, userId) — creates a least-privilege
 *      principal with NO role assignment (by design; role assignment is manual).
 *   5. Collect per-org success/failure; continue on failure so one bad org
 *      does not abort the rest.
 *
 * Safety:
 *   - Defaults to --dry-run; pass --apply to write.
 *   - Prints the sanitized target host + database at startup.
 *   - Requires explicit confirmation (Y/n) before --apply on a non-local host.
 *   - Each org runs in its own transaction; failures are isolated.
 *   - All writes in bootstrapOrgIAM / provisionMemberPrincipal use
 *     ON CONFLICT DO NOTHING / select-then-insert, so re-running is safe.
 *
 * Usage:
 *   pnpm db:backfill-iam              # dry-run (safe, read-only)
 *   pnpm db:backfill-iam -- --apply   # write changes
 *
 * Env:
 *   DATABASE_URL — required. Sourced from .env.local via --env-file-if-exists.
 *   tsx --env-file does NOT override a shell-set DATABASE_URL (see [[prod-db-ops]]).
 *   Always double-check the printed target host before running --apply.
 *
 * Instrumentation:
 *   Prints total orgs scanned, seeded, skipped (already-seeded), and failed
 *   with per-org timing. [[instrument-everything]]
 */

import { createInterface } from "node:readline";
import { URL } from "node:url";
import kleur from "kleur";
import { requireEnv } from "@oxagen/config/env";
import { formatError } from "./lib/format-error";
import { db, closeDatabase, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { bootstrapOrgIAM, provisionMemberPrincipal } from "@oxagen/handlers";

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply");

// ── Startup banner ─────────────────────────────────────────────────────────────

function sanitizeUrl(raw: string): { host: string; database: string } {
  try {
    const u = new URL(raw);
    // Strip user:pass from the printed string. Preserve host + path (= db name).
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

// ── Counters / result tracking ────────────────────────────────────────────────

interface OrgResult {
  orgId: string;
  publicId: string;
  name: string;
  status: "seeded" | "skipped" | "failed" | "dry-run";
  ownerUserId?: string;
  membersProvisioned?: number;
  durationMs?: number;
  error?: string;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const start = Date.now();

  // ── Env validation (only DATABASE_URL needed — db() is lazy) ──────────────
  const env = requireEnv(["DATABASE_URL"]);
  const { host, database } = sanitizeUrl(env.DATABASE_URL);

  console.log(
    kleur.cyan("┌─────────────────────────────────────────────────────────┐"),
  );
  console.log(
    kleur.cyan("│          backfill-org-iam — OXA IAM backfill            │"),
  );
  console.log(
    kleur.cyan("└─────────────────────────────────────────────────────────┘"),
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

  // ── 1. Enumerate all orgs ──────────────────────────────────────────────────
  const allOrgs = await d
    .select({
      id: schema.organizations.id,
      publicId: schema.organizations.publicId,
      name: schema.organizations.name,
    })
    .from(schema.organizations)
    .orderBy(schema.organizations.createdAt);

  console.log(
    kleur.cyan(
      `[backfill-iam] ${allOrgs.length} org(s) found — checking IAM state…`,
    ),
  );
  console.log();

  const results: OrgResult[] = [];

  for (const org of allOrgs) {
    const orgStart = Date.now();

    // ── 2. Check whether any principal already exists for this org ───────────
    const existingPrincipals = await d
      .select({ id: schema.principals.id })
      .from(schema.principals)
      .where(eq(schema.principals.orgId, org.id))
      .limit(1);

    if (existingPrincipals.length > 0) {
      results.push({
        orgId: org.id,
        publicId: org.publicId,
        name: org.name,
        status: "skipped",
        durationMs: Date.now() - orgStart,
      });
      console.log(
        kleur.dim(`  [skip] ${org.name} (${org.publicId}) — already seeded`),
      );
      continue;
    }

    // ── 3. Find all org members ───────────────────────────────────────────────
    const members = await d
      .select({
        userId: schema.orgUsers.userId,
        role: schema.orgUsers.role,
      })
      .from(schema.orgUsers)
      .where(eq(schema.orgUsers.orgId, org.id));

    const ownerRow = members.find((m) => m.role === "owner");
    if (!ownerRow) {
      const msg = `No owner (role='owner') found in org_users for org ${org.publicId}`;
      console.log(kleur.red(`  [fail] ${org.name} (${org.publicId}) — ${msg}`));
      results.push({
        orgId: org.id,
        publicId: org.publicId,
        name: org.name,
        status: "failed",
        error: msg,
        durationMs: Date.now() - orgStart,
      });
      continue;
    }

    const nonOwnerMembers = members.filter((m) => m.role !== "owner");

    if (DRY_RUN) {
      console.log(
        kleur.blue(
          `  [dry-run] ${org.name} (${org.publicId}) — WOULD seed: owner=${ownerRow.userId} + ${nonOwnerMembers.length} member(s)`,
        ),
      );
      results.push({
        orgId: org.id,
        publicId: org.publicId,
        name: org.name,
        status: "dry-run",
        ownerUserId: ownerRow.userId,
        membersProvisioned: nonOwnerMembers.length,
        durationMs: Date.now() - orgStart,
      });
      continue;
    }

    // ── 4. Apply in a transaction (owner IAM + member principals) ────────────
    try {
      await d.transaction(async (tx) => {
        // Bootstrap 7 system roles + owner principal + owner PRA + role_grants.
        await bootstrapOrgIAM({
          orgId: org.id,
          ownerUserId: ownerRow.userId,
          actorUserId: ownerRow.userId,
          tx,
        });

        // Provision least-privilege principal for each non-owner member.
        // No role assignment by design — least-privilege until explicitly granted.
        for (const member of nonOwnerMembers) {
          await provisionMemberPrincipal({
            orgId: org.id,
            userId: member.userId,
            actorUserId: ownerRow.userId,
            tx,
          });
        }
      });

      const durationMs = Date.now() - orgStart;
      console.log(
        kleur.green(
          `  [seeded] ${org.name} (${org.publicId}) — owner=${ownerRow.userId} + ${nonOwnerMembers.length} member(s) [${durationMs}ms]`,
        ),
      );
      results.push({
        orgId: org.id,
        publicId: org.publicId,
        name: org.name,
        status: "seeded",
        ownerUserId: ownerRow.userId,
        membersProvisioned: nonOwnerMembers.length,
        durationMs,
      });
    } catch (err: unknown) {
      const msg = formatError(err);
      console.log(kleur.red(`  [fail] ${org.name} (${org.publicId}) — ${msg}`));
      results.push({
        orgId: org.id,
        publicId: org.publicId,
        name: org.name,
        status: "failed",
        ownerUserId: ownerRow.userId,
        error: msg,
        durationMs: Date.now() - orgStart,
      });
    }
  }

  // ── 5. Summary ───────────────────────────────────────────────────────────
  const scanned = results.length;
  const seeded = results.filter((r) => r.status === "seeded").length;
  const dryRun = results.filter((r) => r.status === "dry-run").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const totalMs = Date.now() - start;

  console.log();
  console.log(
    kleur.cyan("─────────────────────────────────────────────────────────"),
  );
  console.log(kleur.cyan(`[backfill-iam] Summary (${totalMs}ms)`));
  console.log(`  Orgs scanned         : ${scanned}`);
  if (DRY_RUN) {
    console.log(`  Would seed           : ${kleur.blue(String(dryRun))}`);
  } else {
    console.log(
      `  Seeded               : ${seeded > 0 ? kleur.green(String(seeded)) : kleur.dim("0")}`,
    );
  }
  console.log(`  Skipped (already ok) : ${kleur.dim(String(skipped))}`);
  console.log(
    `  Failed               : ${failed > 0 ? kleur.red(String(failed)) : kleur.dim("0")}`,
  );

  if (failed > 0) {
    console.log();
    console.log(kleur.red("[backfill-iam] Failed orgs:"));
    for (const r of results.filter((r) => r.status === "failed")) {
      console.log(kleur.red(`  - ${r.name} (${r.publicId}): ${r.error}`));
    }
  }

  if (DRY_RUN) {
    console.log();
    console.log(
      kleur.blue(
        "[backfill-iam] This was a dry-run. Re-run with --apply to write changes.",
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
    console.error(kleur.red("[backfill-iam] Fatal:"), formatError(err));
    process.exit(1);
  });
