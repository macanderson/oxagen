#!/usr/bin/env tsx
/**
 * backfill-skill-toml.ts — convert legacy Markdown skill bodies to canonical TOML.
 *
 * The TOML cutover made canonical `skill.toml` the stored form of
 * `agent.skill_versions.body`. Rows written before it hold Markdown with YAML
 * frontmatter, and every read path that calls `canonicalizeSkillArtifact`
 * (skill.version.get, skill.export, skill.edit) now throws on them. This script
 * converts those rows.
 *
 * Companion migration:
 *   packages/database/atlas/migrations/20260807090000_skill_versions_legacy_body.sql
 * adds legacy_body / legacy_body_checksum / migrated_at. Run it first.
 *
 * Algorithm:
 *   1. Enumerate skill_versions joined to their skill's slug. This crosses
 *      tenants, which is the documented withSystemDb case (a trusted system
 *      job) — discovery only, no writes.
 *   2. Classify each row (packages/handlers/src/skill-legacy-migration.ts):
 *      already canonical, convertible, or ambiguous.
 *   3. Write each convertible row inside its OWN tenant scope via
 *      runInTenantScope + withTenantDb, so RLS stays load-bearing on the write
 *      path and every mutation is attributed to the row's org/workspace.
 *
 * Safety:
 *   - Defaults to a dry run; pass --apply to write.
 *   - Prints the sanitized target host + database at startup, and requires
 *     explicit confirmation before --apply against a non-local host.
 *   - AMBIGUOUS ROWS ARE NEVER CONVERTED. A body with no frontmatter, an
 *     unparseable one, a missing description, an empty instruction body, or a
 *     reference escaping its bundle is reported for a human, not guessed at.
 *   - Idempotent: conversion sets legacy_body, and any row with legacy_body
 *     already set is skipped. Re-running after a partial failure is safe and
 *     cannot overwrite preserved provenance.
 *   - Per-row failure is isolated — one bad row does not abort the rest.
 *   - The original body is preserved verbatim in legacy_body, with its SHA-256
 *     in legacy_body_checksum.
 *
 * Usage:
 *   tsx tools/scripts/backfill-skill-toml.ts            # dry run + report
 *   tsx tools/scripts/backfill-skill-toml.ts --json     # machine-readable plan
 *   tsx tools/scripts/backfill-skill-toml.ts --apply    # write changes
 *
 * Env:
 *   DATABASE_URL — required. tsx --env-file does NOT override a shell-set
 *   DATABASE_URL; unset it to force local targeting, and always check the
 *   printed target before --apply.
 */

import { createInterface } from "node:readline";
import { URL } from "node:url";
import kleur from "kleur";
import { closeDatabase } from "@oxagen/database";
import {
  formatBackfillReport,
  planSkillBackfill,
} from "@oxagen/handlers/skill-legacy-migration";
import {
  convertSkillVersionRow,
  loadSkillVersionRows,
} from "@oxagen/handlers/skill-legacy-migration.db";
import { formatError } from "./lib/format-error";

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply");
const JSON_OUT = args.includes("--json");

function describeTarget(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const url = new URL(raw);
  return `${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
}

function isLocalTarget(): boolean {
  const url = new URL(process.env.DATABASE_URL ?? "");
  return ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(
    url.hostname,
  );
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${question} [y/N] `, resolve),
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const target = describeTarget();
  console.log(
    `${kleur.bold("backfill-skill-toml")} → ${kleur.cyan(target)} ${
      DRY_RUN ? kleur.yellow("(dry run)") : kleur.red("(APPLY)")
    }`,
  );

  const rows = await loadSkillVersionRows();
  const plan = planSkillBackfill(rows);

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          target,
          dryRun: DRY_RUN,
          scanned: rows.length,
          convertible: plan.convertible.map((i) => ({
            publicId: i.row.publicId,
            slug: i.row.slug,
            versionNumber: i.row.versionNumber,
          })),
          canonical: plan.canonical.length,
          ambiguous: plan.ambiguous.map((i) => ({
            publicId: i.row.publicId,
            slug: i.row.slug,
            versionNumber: i.row.versionNumber,
            reason:
              i.classification.kind === "ambiguous"
                ? i.classification.reason
                : "unknown",
            detail:
              i.classification.kind === "ambiguous"
                ? i.classification.detail
                : undefined,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`scanned: ${rows.length}`);
    console.log(formatBackfillReport(plan));
  }

  if (DRY_RUN) {
    console.log(
      kleur.yellow(
        "\nDry run — nothing written. Re-run with --apply to convert.",
      ),
    );
    return;
  }
  if (plan.convertible.length === 0) {
    console.log(kleur.green("\nNothing to convert."));
    return;
  }
  if (
    !isLocalTarget() &&
    !(await confirm(
      `\nConvert ${plan.convertible.length} skill version(s) on ${target}?`,
    ))
  ) {
    console.log("Aborted.");
    process.exitCode = 1;
    return;
  }

  let converted = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of plan.convertible) {
    if (item.classification.kind !== "convertible") continue;
    try {
      const didWrite = await convertSkillVersionRow(
        item.row,
        item.classification.content,
      );
      if (didWrite) converted += 1;
      else skipped += 1; // Another run got there first.
    } catch (error) {
      failed += 1;
      console.error(
        kleur.red(
          `  ${item.row.publicId} (${item.row.slug} v${item.row.versionNumber}) failed: ${formatError(error)}`,
        ),
      );
    }
  }

  console.log(
    `\nconverted: ${converted}  already-done: ${skipped}  failed: ${failed}  ` +
      `ambiguous-left-untouched: ${plan.ambiguous.length}`,
  );
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error("[backfill-skill-toml] failed", formatError(error));
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
