#!/usr/bin/env tsx
/**
 * assistant-model-keys.ts — backfill and reconcile per-organisation model keys
 * (ADR-131).
 *
 * Two jobs, one script, because they share every piece of setup and are read
 * together:
 *
 *   backfill    mint a key for every organisation that has none.
 *   reconcile   compare what OpenRouter holds with what Postgres holds, and
 *               name every row that is only on one side.
 *
 * WHY RECONCILE EXISTS. Provisioning is detached from organisation creation
 * and never fails a signup, so a failed mint is silent by design. This report
 * is the only thing that makes that silence visible. It is also what catches an
 * orphan: a key minted at the vendor whose row was never written, which spends
 * nothing today but is a live credential nobody is tracking.
 *
 * Safety:
 *   - Defaults to a dry run. `--apply` is required to mint anything.
 *   - `reconcile` never writes and ignores `--apply`.
 *   - Prints the target host and database before doing anything.
 *   - One organisation per attempt; a failure is reported and the run
 *     continues, because one bad organisation must not stop the rest.
 *   - Idempotent: `ensureAssistantModelKey` reads first and the `org_id`
 *     unique index refuses a second row, so re-running mints nothing new.
 *
 * Secrets: the management key is read by `@oxagen/ai/openrouter-provisioning`
 * and never printed. No output of this script carries key material; a key is
 * identified by its hash, its name and the vendor's own masked label.
 *
 * Usage:
 *   tsx tools/scripts/assistant-model-keys.ts reconcile
 *   tsx tools/scripts/assistant-model-keys.ts backfill
 *   tsx tools/scripts/assistant-model-keys.ts backfill --apply
 *   tsx tools/scripts/assistant-model-keys.ts backfill --apply --limit 20
 *
 * Env:
 *   DATABASE_URL, AUTH_TOKEN_ENCRYPTION_KEY, OPENROUTER_MANAGEMENT_KEY.
 *   `tsx --env-file` does NOT override a shell-set DATABASE_URL. Check the
 *   printed target before passing --apply.
 */

import { URL } from "node:url";
import { and, isNull, ne, sql } from "drizzle-orm";
import kleur from "kleur";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { listAssistantModelKeyHandles } from "@oxagen/database/assistant-model-key";
import { ensureAssistantModelKey } from "@oxagen/ai/key-provisioning";
import { listAssistantKeys } from "@oxagen/ai/openrouter-provisioning";
import { formatError } from "./lib/format-error";
import {
  classifyBackfillOutcome,
  hasCeilingDrift,
  isLiveAtVendorButDisabledHere,
  parseLimitFlag,
} from "./lib/assistant-model-keys";

// ── flags ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const MODE = argv[0] === "backfill" ? "backfill" : "reconcile";
const APPLY = argv.includes("--apply");
const LIMIT = (() => {
  const flag = parseLimitFlag(argv);
  if (!flag.ok) {
    console.error(
      kleur.red(
        `--limit needs a positive whole number; got ${flag.got === undefined ? "nothing" : `"${flag.got}"`}.`,
      ),
      kleur.red("\nLeave the flag off to run without a cap."),
    );
    process.exit(1);
  }
  return flag.limit;
})();

function target(): string {
  const raw = process.env["DATABASE_URL"];
  if (!raw) {
    console.error(kleur.red("DATABASE_URL is unset."));
    process.exit(1);
  }
  const url = new URL(raw);
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

// ── the organisations with no key ────────────────────────────────────────────

interface OrgRow {
  readonly id: string;
  readonly slug: string;
  readonly email: string;
}

/**
 * Every organisation with no `assistant_model_keys` row, with the email of the
 * member who owns it.
 *
 * The owner rather than the creator: `org_users` records the role, and the
 * creator's identity is not kept separately once the row is written. For an
 * organisation created by the signup flow the two are the same person. For one
 * where they have since diverged, the owner is the better answer anyway,
 * because the name exists so an operator can tell whose key this is.
 */
async function orgsWithoutKey(): Promise<OrgRow[]> {
  // tenancy: system bypass via withSystemDb (cross-tenant backfill; no single
  // organisation's scope applies) (see docs/specs/tenancy-rls/spec.md)
  const rows = await withSystemDb(async (tx) =>
    tx
      .select({
        id: schema.organizations.id,
        slug: schema.organizations.slug,
        email: schema.users.email,
      })
      .from(schema.organizations)
      .leftJoin(
        schema.assistantModelKeys,
        sql`${schema.assistantModelKeys.orgId} = ${schema.organizations.id}`,
      )
      .innerJoin(
        schema.orgUsers,
        // lower(role), because org_users records the role in both casings and
        // its own CHECK is written `lower(role) IN (...)`. Matching 'owner'
        // exactly skips an organisation whose owner row reads 'Owner', and
        // skips it with no output at all.
        sql`${schema.orgUsers.orgId} = ${schema.organizations.id} and lower(${schema.orgUsers.role}) = 'owner'`,
      )
      .innerJoin(
        schema.users,
        sql`${schema.users.id} = ${schema.orgUsers.userId}`,
      )
      .where(
        and(
          isNull(schema.assistantModelKeys.orgId),
          // A deleted organisation is a retained row, not an absent one.
          // Minting for it would put a live, spendable credential behind an
          // organisation the rest of the product treats as gone.
          ne(schema.organizations.status, "deleted"),
        ),
      ),
  );
  // An organisation with two owner rows would otherwise be minted for twice;
  // the second attempt loses the unique index and deletes its own key, which
  // is correct but wasteful and reads like a fault in the output.
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.id) && seen.add(r.id));
}

// ── backfill ─────────────────────────────────────────────────────────────────

async function backfill(): Promise<number> {
  const orgs = (await orgsWithoutKey()).slice(0, LIMIT);
  console.log(
    `${orgs.length} organisation(s) with no key${
      LIMIT === Number.POSITIVE_INFINITY ? "" : ` (limited to ${LIMIT})`
    }.`,
  );
  if (!APPLY) {
    for (const o of orgs) console.log(`  would mint  ${o.slug}  ${o.email}`);
    console.log(kleur.yellow("\nDry run. Pass --apply to mint."));
    return 0;
  }

  const counts = { provisioned: 0, skipped: 0, failed: 0 };
  for (const org of orgs) {
    try {
      const result = await ensureAssistantModelKey({
        orgId: org.id,
        orgSlug: org.slug,
        creatorEmail: org.email,
        // A backfill has no actor. Attributing it to the owner would record a
        // person as having done something they did not do.
        actorUserId: null,
      });
      switch (classifyBackfillOutcome(result)) {
        case "minted":
          counts.provisioned += 1;
          console.log(kleur.green(`  minted   ${org.slug}`));
          break;
        case "skipped":
          counts.skipped += 1;
          console.log(kleur.dim(`  skipped  ${org.slug}  (${result.reason})`));
          break;
        default:
          counts.failed += 1;
          console.log(kleur.red(`  failed   ${org.slug}  (${result.reason})`));
      }
    } catch (err) {
      // ensureAssistantModelKey answers its own failures, so reaching here
      // means something outside it broke. Report and keep going.
      counts.failed += 1;
      console.log(kleur.red(`  failed   ${org.slug}  ${formatError(err)}`));
    }
  }

  console.log(
    `\nminted ${counts.provisioned}, skipped ${counts.skipped}, failed ${counts.failed}`,
  );
  return counts.failed > 0 ? 1 : 0;
}

// ── reconcile ────────────────────────────────────────────────────────────────

async function reconcile(): Promise<number> {
  const managementKey = process.env["OPENROUTER_MANAGEMENT_KEY"];
  if (!managementKey) {
    console.error(
      kleur.red("OPENROUTER_MANAGEMENT_KEY is unset, so there is nothing to"),
      kleur.red("compare Postgres against."),
    );
    return 1;
  }

  const [vendor, ours] = await Promise.all([
    listAssistantKeys({ managementKey }),
    listAssistantModelKeyHandles(),
  ]);

  const byHash = new Map(ours.map((r) => [r.keyHash, r]));
  const vendorHashes = new Set(vendor.map((k) => k.hash));

  // Only keys this codebase minted. The account also holds keys created by
  // hand, and reporting those as orphans would make the report unreadable.
  const mine = vendor.filter((k) => k.name.startsWith("oxagen/"));

  const orphans = mine.filter((k) => !byHash.has(k.hash));
  const phantoms = ours.filter((r) => !vendorHashes.has(r.keyHash));
  const disabledHere = ours.filter((r) =>
    isLiveAtVendorButDisabledHere(r, mine),
  );
  const ceilingDrift = mine.flatMap((k) => {
    const row = byHash.get(k.hash);
    if (!row || !hasCeilingDrift(k, row.dailyLimitUsd)) return [];
    return [{ key: k, expected: row.dailyLimitUsd }];
  });

  console.log(
    `${mine.length} Oxagen key(s) at the vendor, ${ours.length} row(s) here.\n`,
  );

  // The since-creation total is the wrong period to hand an operator checking
  // an invoice, and it drifts further from the right one as the key ages. The
  // vendor already reports the month, so print it beside the total rather than
  // leaving the report with no comparable aggregate at all.
  console.log("Spend by organisation (total since the key was minted):");
  for (const k of [...mine].sort((a, b) => b.usage - a.usage)) {
    const row = byHash.get(k.hash);
    console.log(
      `  ${k.name.padEnd(56)} ${`$${k.usage.toFixed(2)}`.padStart(10)}` +
        `  month $${k.usageMonthly.toFixed(2)}` +
        `  today $${k.usageDaily.toFixed(2)}` +
        `  limit ${k.limit === null ? "none" : `$${k.limit}/${k.limitReset ?? "?"}`}` +
        `  ${row ? row.orgId : kleur.yellow("no row")}`,
    );
  }

  const report = (
    label: string,
    lines: string[],
    colour: (s: string) => string,
  ): void => {
    if (lines.length === 0) return;
    console.log(`\n${colour(label)}`);
    for (const line of lines) console.log(`  ${line}`);
  };

  report(
    `${orphans.length} key(s) at the vendor with no row here. Each is a live credential nobody is tracking.`,
    orphans.map((k) => `${k.name}  ${k.hash}  ${k.label}`),
    kleur.red,
  );
  report(
    `${phantoms.length} row(s) here with no key at the vendor. Every turn for these organisations falls back to the shared key.`,
    phantoms.map((r) => `${r.keyName}  ${r.orgId}`),
    kleur.red,
  );
  report(
    `${disabledHere.length} key(s) disabled here but still live at the vendor.`,
    disabledHere.map((r) => `${r.keyName}  ${r.keyHash}`),
    kleur.yellow,
  );
  report(
    `${ceilingDrift.length} key(s) whose vendor ceiling does not match this row.`,
    ceilingDrift.map(
      ({ key, expected }) =>
        `${key.name}  vendor ${key.limit === null ? "none" : `$${key.limit}/${key.limitReset ?? "?"}`}, here $${expected}/daily`,
    ),
    kleur.yellow,
  );

  // Every category above is a disagreement between the vendor and Postgres,
  // so every category counts. Leaving two of them out let the report print its
  // drift and then print "Vendor and Postgres agree." underneath it, and exit
  // 0, so an automated reconciliation recorded success on a live disabled key
  // or a wrong ceiling.
  const faults =
    orphans.length +
    phantoms.length +
    disabledHere.length +
    ceilingDrift.length;
  if (faults === 0) console.log(kleur.green("\nVendor and Postgres agree."));
  return faults > 0 ? 1 : 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(kleur.dim(`target: ${target()}`));
  console.log(
    kleur.dim(
      `mode:   ${MODE}${MODE === "backfill" && APPLY ? " --apply" : ""}\n`,
    ),
  );

  const code = MODE === "backfill" ? await backfill() : await reconcile();
  await closeDatabase();
  process.exit(code);
}

void main().catch(async (err: unknown) => {
  console.error(kleur.red(formatError(err)));
  await closeDatabase();
  process.exit(1);
});
