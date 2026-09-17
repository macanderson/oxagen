/**
 * The grant and a refund must not both decide about one purchase (ADR-085 §5).
 *
 * This is the only test in the reversal work that cannot be written against the
 * in-memory executor, and the reason is the defect itself: it is a **write
 * skew** between two transactions that are open at the same time. A
 * single-connection test cannot exhibit it, and a sequential "park, then grant"
 * case passes against the unfixed code — sequential is the ordering that
 * already worked. What discriminates is two real transactions where the second
 * reaches its read before the first commits.
 *
 * Under READ COMMITTED, without a shared lock:
 *
 *   refund tx                          grant tx
 *   ─────────                          ────────
 *                                      INSERT settlement        (uncommitted)
 *   SELECT settlement  → none          │
 *   INSERT pending reversal            │
 *   │                                  SELECT pending → none    (uncommitted)
 *   COMMIT                             COMMIT
 *
 * Both succeed. The purchase stays spendable and the reversal stays pending for
 * ever, because a checkout redelivery stops at the settlement that now exists
 * and never reaches reconciliation again. Neither transaction did anything
 * wrong in isolation; the bucket's row lock does not help, because these two
 * write different tables.
 *
 * `pg_advisory_xact_lock` keyed on the PaymentIntent is what makes the
 * interleaving impossible. The first test drives the unlocked interleaving to
 * prove the hazard is real against this schema rather than only on paper; the
 * second drives the same interleaving with the lock and shows the second
 * transaction blocks until the first commits and then reads what it wrote.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database test:integration
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";

/** Two clients, one connection each: two genuinely concurrent sessions. */
const a = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });
const b = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });
/** A third for setup and assertions, so neither participant is disturbed. */
const admin = postgres(process.env["DATABASE_URL"]!, {
  max: 1,
  prepare: false,
});

const ORG = "00000000-0000-0000-0085-000000000001";
const BUCKET = "00000000-0000-0000-0085-000000000002";
const PI = "pi_concurrency_test";

const LOCK = (pi: string) =>
  `SELECT pg_advisory_xact_lock(hashtextextended('gau_purchase:${pi}'::text, 0))`;

async function reset() {
  await admin.unsafe(`
    SET app.rls_bypass = 'on';
    DELETE FROM billing.gau_reversals WHERE org_id = '${ORG}';
    DELETE FROM billing.gau_settlements WHERE org_id = '${ORG}';
    DELETE FROM billing.gau_buckets WHERE org_id = '${ORG}';
    DELETE FROM org.organizations WHERE id = '${ORG}';
    INSERT INTO org.organizations (id, public_id, name, slug, plan_type, status, namespace)
      VALUES ('${ORG}', 'org_c85', 'Concurrency', 'conc-85', 'free', 'active', 'conc85');
    INSERT INTO billing.gau_buckets (id, org_id, period_start, period_end, included_gau, purchased_gau)
      VALUES ('${BUCKET}', '${ORG}', '2026-09-01Z', '2026-10-01Z', 5000, 0);
  `);
}

/** A single statement, so `postgres` returns its rows rather than a summary. */
async function scalar(query: string): Promise<number> {
  await admin.unsafe(`SET app.rls_bypass = 'on'`);
  const rows = (await admin.unsafe(query)) as unknown as { n: string }[];
  if (rows.length !== 1)
    throw new Error(`expected one row, got ${rows.length}`);
  return Number(rows[0]!.n);
}

/** What the gate reads: units the customer can actually spend. */
function spendableUnits(): Promise<number> {
  return scalar(
    `SELECT (purchased_gau + carried_gau)::int AS n FROM billing.gau_buckets WHERE id = '${BUCKET}'`,
  );
}

function pendingReversals(): Promise<number> {
  return scalar(
    `SELECT count(*)::int AS n FROM billing.gau_reversals
      WHERE org_id = '${ORG}' AND settlement_id IS NULL`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A one-shot signal between the two connections.
 *
 * These tests construct an interleaving, and the first version constructed it
 * with timers — one transaction slept 100ms while the other slept 200ms. That
 * works on an idle box and is load-dependent everywhere else: on a busy runner
 * the window can elapse before the first transaction reaches the point the race
 * needs, the interleaving never happens, and the UNLOCKED variant observes the
 * correct final state. It would pass for the wrong reason, which is precisely
 * what these tests exist to rule out — the discriminator failing the test it
 * applies to everything else.
 *
 * A barrier removes the dependency: the second transaction proceeds because the
 * first has demonstrably arrived, not because a timer expired.
 */
function barrier(): { arrive: () => void; reached: Promise<void> } {
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = () => resolve();
  });
  return { arrive, reached };
}

/**
 * Wait for a barrier, but never for ever.
 *
 * In the LOCKED variants the peer is blocked on a Postgres row or advisory lock
 * held by this transaction, so it cannot arrive — waiting for it would deadlock.
 * That is not a flaw in the barrier: when the lock does its job the interleaving
 * is impossible by construction, which is the whole point. The cap lets the lock
 * take over, and the locked assertions hold for either resulting order by
 * design. In the UNLOCKED variants the peer always arrives and the cap is never
 * reached, so those runs carry no timing dependency at all.
 */
const LOCK_YIELD_MS = 3_000;
function waitOrYield(reached: Promise<void>): Promise<unknown> {
  return Promise.race([reached, sleep(LOCK_YIELD_MS)]);
}

/**
 * Drives ONE forced interleaving, with the lock as the only variable.
 *
 * The timings pin the order that produces the skew: the refund reads first and
 * commits last, so its parked row is invisible to the grant's reconciliation
 * read while the grant's settlement is invisible to the refund's lookup.
 *
 *   t=0    refund  [lock?] SELECT settlement → none
 *   t=0    refund  INSERT pending reversal   (uncommitted)
 *   t=0    grant   [lock?] INSERT settlement (uncommitted), bucket += 10000
 *   t=100  grant   SELECT pending → ???
 *   t=100  grant   COMMIT
 *   t=200  refund  COMMIT
 *
 * Unlocked, the grant's read at t=100 misses a row that commits at t=200 and
 * both transactions commit — that is the defect. Locked, the grant cannot
 * start until the refund releases at t=200, so it reads what the refund wrote.
 * Every wait is on a lock or a fixed delay, so neither outcome depends on
 * scheduling luck.
 */
async function runInterleaved(opts: { lock: boolean }): Promise<void> {
  const maybeLock = async (tx: postgres.TransactionSql) => {
    if (opts.lock) await tx.unsafe(LOCK(PI));
  };
  // refundParked: the refund has written its pending row and NOT committed.
  // grantRead:    the grant has run its reconciliation read.
  const refundParked = barrier();
  const grantRead = barrier();

  const refund = a.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.rls_bypass = 'on'`);
    await maybeLock(tx);
    const settlement = (await tx.unsafe(
      `SELECT id FROM billing.gau_settlements WHERE stripe_payment_intent_id = '${PI}'`,
    )) as unknown as { id: string }[];
    if (settlement.length > 0) {
      // The grant went first and committed: withdraw against it directly.
      await tx.unsafe(
        `INSERT INTO billing.gau_reversals
           (org_id, settlement_id, bucket_id, stripe_payment_intent_id, kind,
            provider_event_id, requested_gau, reversed_gau, unrecovered_gau, amount_cents, currency)
         VALUES ('${ORG}', '${settlement[0]!.id}', '${BUCKET}', '${PI}', 'refund',
                 'ch_conc', 10000, 10000, 0, 5500, 'usd')`,
      );
      await tx.unsafe(
        `UPDATE billing.gau_buckets SET purchased_gau = purchased_gau - 10000 WHERE id = '${BUCKET}'`,
      );
    } else {
      await tx.unsafe(
        `INSERT INTO billing.gau_reversals
           (org_id, settlement_id, bucket_id, stripe_payment_intent_id, kind,
            provider_event_id, requested_gau, reversed_gau, unrecovered_gau, amount_cents, currency)
         VALUES ('${ORG}', NULL, NULL, '${PI}', 'refund', 'ch_conc', 0, 0, 0, 5500, 'usd')`,
      );
    }
    // Parked but uncommitted: the grant's read must happen now, while this row
    // is invisible to it.
    refundParked.arrive();
    await waitOrYield(grantRead.reached);
  });

  const grant = b.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.rls_bypass = 'on'`);
    await maybeLock(tx);
    await waitOrYield(refundParked.reached);
    await tx.unsafe(
      `INSERT INTO billing.gau_settlements
         (org_id, bucket_id, kind, seq, quantity_gau, rate_per_gau_micros, currency,
          status, stripe_checkout_session_id, stripe_payment_intent_id, charged_cents, settled_at)
       VALUES ('${ORG}', '${BUCKET}', 'checkout', NULL, 10000, 5000, 'usd',
               'paid', 'cs_conc', '${PI}', 5500, now())`,
    );
    await tx.unsafe(
      `UPDATE billing.gau_buckets SET purchased_gau = purchased_gau + 10000 WHERE id = '${BUCKET}'`,
    );
    const pending = (await tx.unsafe(
      `SELECT id FROM billing.gau_reversals
        WHERE stripe_payment_intent_id = '${PI}' AND settlement_id IS NULL`,
    )) as unknown as { id: string }[];
    grantRead.arrive();
    for (const row of pending) {
      await tx.unsafe(
        `UPDATE billing.gau_reversals
            SET settlement_id = (SELECT id FROM billing.gau_settlements
                                  WHERE stripe_payment_intent_id = '${PI}'),
                bucket_id = '${BUCKET}', requested_gau = 10000,
                reversed_gau = 10000, unrecovered_gau = 0
          WHERE id = '${row.id}'`,
      );
      await tx.unsafe(
        `UPDATE billing.gau_buckets SET purchased_gau = purchased_gau - 10000 WHERE id = '${BUCKET}'`,
      );
    }
  });

  await Promise.all([refund, grant]);
}

beforeEach(reset);

afterAll(async () => {
  await admin.unsafe(`SET app.rls_bypass = 'on'`);
  for (const stmt of [
    `DELETE FROM billing.gau_reversals WHERE org_id = '${ORG}'`,
    `DELETE FROM billing.gau_settlements WHERE org_id = '${ORG}'`,
    `DELETE FROM billing.gau_buckets WHERE org_id = '${ORG}'`,
    `DELETE FROM org.organizations WHERE id = '${ORG}'`,
  ]) {
    await admin.unsafe(stmt);
  }
  await Promise.all([a.end(), b.end(), admin.end()]);
});

/**
 * A reversal debiting the bucket while an unrelated purchase lands on it.
 *
 * The PaymentIntent advisory lock serialises reversals of ONE purchase against
 * each other. A concurrent checkout or auto top-up is a different PaymentIntent
 * and takes a different lock, so it is not held back at all — the lock never
 * protected the bucket from it. What protects the bucket is the row lock that
 * `ensureCurrentBucket`'s upsert takes.
 *
 * `locked: false` reproduces the read-modify-write: a plain SELECT, then a
 * concurrent relative increment commits, then an absolute write from the stale
 * snapshot erases it. `locked: true` takes the row lock the way the code does.
 */
async function runBucketRace(opts: { locked: boolean }): Promise<void> {
  // reversalRead: the reversal has taken its snapshot and NOT written.
  // purchaseDone: the concurrent purchase has COMMITTED its increment.
  const reversalRead = barrier();
  const purchaseDone = barrier();

  const reversal = a.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.rls_bypass = 'on'`);
    // Both forms read the same counts; only one holds the row while it does.
    const rows = opts.locked
      ? await tx.unsafe(
          `SELECT purchased_gau FROM billing.gau_buckets WHERE id = '${BUCKET}' FOR UPDATE`,
        )
      : await tx.unsafe(
          `SELECT purchased_gau FROM billing.gau_buckets WHERE id = '${BUCKET}'`,
        );
    const before = Number(
      (rows as unknown as { purchased_gau: string }[])[0]!.purchased_gau,
    );
    reversalRead.arrive();
    // The purchase must land and COMMIT in this gap for the stale write to
    // erase it. Locked, it cannot: it blocks on the row this transaction
    // holds, the cap expires, and the lock imposes the order instead.
    await waitOrYield(purchaseDone.reached);
    // The absolute write from the snapshot read above.
    await tx.unsafe(
      `UPDATE billing.gau_buckets SET purchased_gau = ${before - 2000} WHERE id = '${BUCKET}'`,
    );
  });

  // Not a bare `b.begin(…)`: the signal has to fire after the COMMIT, so the
  // reversal's write is genuinely racing a committed increment rather than an
  // invisible one.
  const purchase = (async () => {
    await reversalRead.reached;
    await b.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.rls_bypass = 'on'`);
      // A different purchase on a different PaymentIntent: a relative increment
      // under the bucket's own row lock, exactly what ensureCurrentBucket issues.
      await tx.unsafe(
        `INSERT INTO billing.gau_buckets (id, org_id, period_start, period_end, included_gau, purchased_gau)
         VALUES ('${BUCKET}', '${ORG}', '2026-09-01Z', '2026-10-01Z', 5000, 5000)
         ON CONFLICT (org_id, period_start)
         DO UPDATE SET purchased_gau = billing.gau_buckets.purchased_gau + EXCLUDED.purchased_gau`,
      );
    });
    purchaseDone.arrive();
  })();

  await Promise.all([reversal, purchase]);
}

describe("a reversal debiting while an unrelated purchase lands", () => {
  it("WITHOUT the row lock, the absolute write erases the new purchase", async () => {
    // Start at 10,000. The reversal takes 2,000 and a concurrent purchase adds
    // 5,000, so the honest total is 13,000. The stale snapshot writes 8,000 and
    // the 5,000 just paid for is gone.
    await admin.unsafe(`SET app.rls_bypass = 'on'`);
    await admin.unsafe(
      `UPDATE billing.gau_buckets SET purchased_gau = 10000 WHERE id = '${BUCKET}'`,
    );

    await runBucketRace({ locked: false });

    expect(await spendableUnits()).toBe(8_000);
  });

  it("WITH the row lock, the purchase survives the debit", async () => {
    await admin.unsafe(`SET app.rls_bypass = 'on'`);
    await admin.unsafe(
      `UPDATE billing.gau_buckets SET purchased_gau = 10000 WHERE id = '${BUCKET}'`,
    );

    await runBucketRace({ locked: true });

    // 10,000 − 2,000 + 5,000. The purchase waits for the reversal to commit and
    // increments the post-debit figure.
    expect(await spendableUnits()).toBe(13_000);
  });
});

describe("a debit alongside a writer of other columns on the same row", () => {
  // `billing.gau_buckets` has eight writers and seven of them set columns the
  // reversal never names — overage_invoiced_gau, closed_at, the seqs,
  // open_topup_settlement_id. This pins that a debit and one of those writers
  // coexist: both land, and `gau_buckets_overage_invoiced_within_used` still
  // holds.
  //
  // Be honest about what it does NOT prove. The obvious fear is a
  // read-modify-write reverting a column the reversal did not mean to touch —
  // and that is not reachable here, so this test cannot discriminate it. Making
  // the reversal write every column back from its snapshot leaves this test
  // green, which was checked rather than assumed (4 runs, 4 passes).
  //
  // The reason is that the reversal's read is INSIDE the row lock:
  //
  //   t0    reversal  SELECT … FOR UPDATE   holds the row
  //   t100  interim   UPDATE …              blocks
  //   t200  reversal  UPDATE, commit        releases
  //   t200  interim   overage += 3000       relative, on the post-reversal row
  //
  // Its values are therefore never stale, and the interim's increment is
  // relative and applies afterwards. The reverse order is safe for the same
  // reason. So naming only the owned columns is defence in depth here, not the
  // load-bearing guarantee — the lock is. What guards the column set if that
  // read ever moves outside the lock is the unit assertion in
  // gau-reversals.test.ts, which does fail when the `.set()` is widened.
  it("leaves a concurrent overage increment intact, and the CHECK holds", async () => {
    const reversalRead = barrier();
    const interimDone = barrier();
    await admin.unsafe(`SET app.rls_bypass = 'on'`);
    await admin.unsafe(
      `UPDATE billing.gau_buckets
          SET purchased_gau = 10000, used_gau = 8000, overage_invoiced_gau = 0
        WHERE id = '${BUCKET}'`,
    );

    const reversal = a.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.rls_bypass = 'on'`);
      const rows = await tx.unsafe(
        `SELECT purchased_gau FROM billing.gau_buckets WHERE id = '${BUCKET}' FOR UPDATE`,
      );
      const before = Number(
        (rows as unknown as { purchased_gau: string }[])[0]!.purchased_gau,
      );
      reversalRead.arrive();
      await waitOrYield(interimDone.reached);
      // Exactly the columns the reversal owns, and no others.
      await tx.unsafe(
        `UPDATE billing.gau_buckets
            SET purchased_gau = ${before - 2000}, updated_at = now()
          WHERE id = '${BUCKET}'`,
      );
    });

    const interim = (async () => {
      await reversalRead.reached;
      await b.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL app.rls_bypass = 'on'`);
        await tx.unsafe(
          `UPDATE billing.gau_buckets
              SET overage_invoiced_gau = overage_invoiced_gau + 3000,
                  interim_seq = interim_seq + 1,
                  updated_at = now()
            WHERE id = '${BUCKET}'`,
        );
      });
      interimDone.arrive();
    })();

    await Promise.all([reversal, interim]);

    const after = await scalar(
      `SELECT (purchased_gau * 100000 + overage_invoiced_gau)::bigint AS n
         FROM billing.gau_buckets WHERE id = '${BUCKET}'`,
    );
    // 8,000 purchased and 3,000 overage: the debit landed and the increment
    // was not reverted. Encoded in one scalar so a single query proves both.
    expect(after).toBe(8000 * 100000 + 3000);
    // The CHECK is still satisfied, which Postgres would have refused otherwise.
    expect(
      await scalar(
        `SELECT (overage_invoiced_gau <= used_gau)::int AS n
           FROM billing.gau_buckets WHERE id = '${BUCKET}'`,
      ),
    ).toBe(1);
  });
});

describe("grant vs refund on one PaymentIntent", () => {
  it("WITHOUT the lock, both commit and the refunded units stay spendable", async () => {
    // The defect, driven against the real schema. Neither transaction did
    // anything wrong in isolation. If this ever stops reproducing, the test
    // below has stopped proving anything and this one is the canary.
    await runInterleaved({ lock: false });

    expect(await spendableUnits()).toBe(10_000);
    expect(await pendingReversals()).toBe(1);
  });

  it("WITH the lock, the same interleaving leaves no spendable units and nothing pending", async () => {
    // Identical timings, identical statements; the lock is the only variable.
    await runInterleaved({ lock: true });

    expect(await spendableUnits()).toBe(0);
    expect(await pendingReversals()).toBe(0);
  });
});
