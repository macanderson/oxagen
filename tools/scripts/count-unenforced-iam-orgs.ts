#!/usr/bin/env tsx
/**
 * count-unenforced-iam-orgs.ts — the exposure query #1384 asked for, #2714 tracks.
 *
 * `checkIAM` bypasses the IAM resolver entirely — an unconditional allow, zero
 * policy queries — for any org that does not resolve to the `enterprise` tier.
 * Tier resolution used to count a subscription only when its status was exactly
 * `active`, so an enterprise org in trial, past due or paused resolved to a
 * lower tier and had every capability check allowed without a single policy
 * being consulted. #2712 fixed the resolution. This answers who was affected.
 *
 * It is READ-ONLY and has no `--apply`. Nothing here changes a tier, a
 * subscription or a policy: this is a question, and the decision about what is
 * owed to the orgs it names belongs to a person.
 *
 * Usage:
 *   tsx tools/scripts/count-unenforced-iam-orgs.ts
 *   tsx tools/scripts/count-unenforced-iam-orgs.ts --json
 *
 * Env:
 *   DATABASE_URL — required, and it must be PRODUCTION. An empty result against
 *   a staging or local database says nothing at all; the printed host is worth
 *   reading before believing the answer.
 *
 * ## What this can and cannot tell you
 *
 * It answers "which orgs are exposed right now, and in what status" exactly.
 *
 * It can only bound "for how long". `billing.subscriptions` keeps the CURRENT
 * status and no history — there is no status-history table in this schema — so
 * the window a subscription has been non-active cannot be read out of Postgres.
 * What is here is a floor, from the columns that do carry a time:
 * `trial_end`, `canceled_at`, `current_period_start` and the row's `updated_at`.
 * The real transition history is in Stripe, and `security_events` carries the
 * subset that emitted an audit row (`billing.subscription_canceled`,
 * `billing.subscription_reactivated`, `billing.plan_changed`). #2714's second
 * item needs one of those two sources; it is not answerable from this query
 * alone, and this says so rather than reporting a floor as if it were the
 * answer.
 */
import kleur from "kleur";
import postgres from "postgres";

/** The statuses old tier resolution refused, and so unenforced IAM for. */
export const PREVIOUSLY_UNENTITLED = [
  "trialing",
  "past_due",
  "paused",
] as const;

export interface ExposedOrg {
  orgId: string;
  orgName: string;
  planType: string;
  planTier: string;
  status: string;
  trialEnd: string | null;
  canceledAt: string | null;
  currentPeriodStart: string | null;
  subscriptionUpdatedAt: string | null;
}

/**
 * The earliest moment this row is KNOWN to have been in a non-active status,
 * or null when nothing in the row carries one.
 *
 * A floor, never a start: the row could have entered this status earlier and
 * been updated since for an unrelated reason. Reporting it as the start is the
 * mistake this function's name exists to prevent.
 */
export function knownUnenforcedSince(org: ExposedOrg): string | null {
  const candidates = [
    org.status === "trialing" ? org.currentPeriodStart : null,
    org.status === "paused" ? org.subscriptionUpdatedAt : null,
    org.status === "past_due" ? org.currentPeriodStart : null,
    org.canceledAt,
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  if (candidates.length === 0) return null;
  return candidates.sort()[0]!;
}

/** Group the rows by status, for the "how many, in which statuses" half. */
export function byStatus(orgs: ExposedOrg[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const o of orgs) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  return counts;
}

export function render(orgs: ExposedOrg[], host: string): string {
  if (orgs.length === 0) {
    return [
      `[unenforced-iam] no org is exposed on ${host}.`,
      "",
      "An empty result is only as good as the database it was run against.",
      "Check the host above is production before recording this on #2714.",
    ].join("\n");
  }

  const lines = [
    `[unenforced-iam] ${orgs.length} org(s) ran without IAM on ${host}:`,
    "",
  ];
  for (const [status, n] of [...byStatus(orgs)].sort()) {
    lines.push(`  ${status}: ${n}`);
  }
  lines.push("");
  for (const o of orgs) {
    const since = knownUnenforcedSince(o);
    lines.push(
      `  ${o.orgId}  ${o.orgName}`,
      `    subscription status ${o.status}, plan tier ${o.planTier}, organizations.plan_type ${o.planType}`,
      `    known non-active since at least ${since ?? "— nothing in the row dates it"}`,
    );
  }
  lines.push(
    "",
    "Those dates are FLOORS, not start times: this schema keeps no subscription",
    "status history. The real window is in Stripe, or in the security_events",
    "rows for billing.subscription_* and billing.plan_changed. #2714's second",
    "item needs one of those.",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(kleur.red("[unenforced-iam] DATABASE_URL is not set."));
    process.exit(1);
  }
  const host = new URL(url).host;
  console.log(kleur.cyan(`[unenforced-iam] querying ${host}`));

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const rows = (await sql`
      select o.id                       as "orgId",
             o.name                     as "orgName",
             o.plan_type                as "planType",
             p.tier                     as "planTier",
             s.status                   as "status",
             s.trial_end                as "trialEnd",
             s.canceled_at              as "canceledAt",
             s.current_period_start     as "currentPeriodStart",
             s.updated_at               as "subscriptionUpdatedAt"
        from billing.subscriptions s
        join billing.plans p on p.id = s.plan_id
        join org.organizations o on o.id = s.org_id
       where p.tier = 'enterprise'
         and s.status <> 'active'
         and o.plan_type <> 'enterprise'
       order by s.status, o.name
    `) as unknown as ExposedOrg[];

    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log(render(rows, host));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error(kleur.red(`[unenforced-iam] ${String(err)}`));
    process.exit(1);
  });
}
