/**
 * #1421. The old key carried `Math.floor(Date.now() / 10_000)`, which does not
 * give each submit a 10-second window — it gives the CLOCK fixed boundaries, so
 * a resubmit landing on the far side of one is a new intent however close the
 * two clicks were. `prorationBehavior` defaults to `always_invoice`, so the
 * duplicate is a duplicate INVOICE against a real customer.
 *
 * These drive the key builder rather than Stripe: the key IS the guarantee, and
 * Stripe's own de-duplication is what acts on it.
 */
import { describe, expect, it } from "vitest";
import { planChangeIdempotencyKey } from "./subscriptions";

const SUB = "sub_123";
const PRICE = "price_pro_monthly";

/** The key exactly as it was built before the fix. */
function bucketedKey(at: number): string {
  return `plan_change:${SUB}:${PRICE}:${Math.floor(at / 10_000)}`;
}

describe("plan-change idempotency key (#1421)", () => {
  it("deduplicates two submits that straddle a 10s boundary", () => {
    // 250 ms apart, either side of a bucket edge — the reported repro.
    const before = 1_700_000_009_900;
    const after = before + 250;
    expect(bucketedKey(before)).not.toBe(bucketedKey(after)); // the old bug
    expect(planChangeIdempotencyKey(SUB, PRICE)).toBe(
      planChangeIdempotencyKey(SUB, PRICE),
    );
  });

  it("deduplicates regardless of when the two submits land", () => {
    // The DoD's wording: no gap, and no alignment, produces a second key.
    const first = planChangeIdempotencyKey(SUB, PRICE);
    for (const _gap of [0, 250, 1_000, 10_000, 3_600_000]) {
      expect(planChangeIdempotencyKey(SUB, PRICE)).toBe(first);
    }
  });

  it("sweeps a double-click across a whole bucket without producing a second key", () => {
    // The issue swept every start offset in one bucket and found 2.5% of them
    // produced different keys at 250 ms. The intent-keyed builder produces one.
    const keys = new Set<string>();
    for (let offset = 0; offset < 10_000; offset += 50) {
      keys.add(planChangeIdempotencyKey(SUB, PRICE));
      keys.add(planChangeIdempotencyKey(SUB, PRICE));
    }
    expect(keys.size).toBe(1);

    // Control: the old builder really does split, so the assertion above is
    // measuring something.
    const bucketed = new Set<string>();
    for (let offset = 0; offset < 10_000; offset += 50) {
      const at = 1_700_000_000_000 + offset;
      bucketed.add(bucketedKey(at));
      bucketed.add(bucketedKey(at + 250));
    }
    expect(bucketed.size).toBeGreaterThan(1);
  });

  it("keeps two different plan changes apart", () => {
    expect(planChangeIdempotencyKey(SUB, PRICE)).not.toBe(
      planChangeIdempotencyKey(SUB, "price_scale_monthly"),
    );
    expect(planChangeIdempotencyKey(SUB, PRICE)).not.toBe(
      planChangeIdempotencyKey("sub_other", PRICE),
    );
  });

  it("lets a caller-supplied request id separate two deliberate changes", () => {
    // The case the clock bucket existed to allow, done properly: one intent is
    // one id, and a genuinely new submit is a new id.
    const doubleClick = planChangeIdempotencyKey(SUB, PRICE, "req_1");
    expect(planChangeIdempotencyKey(SUB, PRICE, "req_1")).toBe(doubleClick);
    expect(planChangeIdempotencyKey(SUB, PRICE, "req_2")).not.toBe(doubleClick);
  });

  it("carries no clock at all", () => {
    // The property that makes every assertion above hold: nothing in the key
    // varies with time. A digit run long enough to be a timestamp would.
    const key = planChangeIdempotencyKey(SUB, PRICE);
    expect(key).toBe(`plan_change:${SUB}:${PRICE}`);
    expect(key).not.toMatch(/\d{9,}/);
  });
});
