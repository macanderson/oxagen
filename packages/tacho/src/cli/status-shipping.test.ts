/**
 * What `tacho status` says about shipping. A host that records but never
 * ships is not working, so the verdict must fail loudly rather than trail
 * the error at the end of the daemon line.
 */
import { describe, expect, it } from "vitest";
import { SHIPPING_STALL_MS, shippingHealth } from "./status";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("the shipping verdict", () => {
  it("fails when the daemon does not answer", () => {
    const verdict = shippingHealth(null, { unshipped: 0 }, NOW);
    expect(verdict.healthy).toBe(false);
    expect(verdict.detail).toContain("not answering");
  });

  it("passes with nothing waiting, whatever the last error was", () => {
    expect(
      shippingHealth({ last_error: "old failure" }, { unshipped: 0 }, NOW)
        .healthy,
    ).toBe(true);
  });

  it("fails with events waiting behind a failed ingest, and names the error", () => {
    const verdict = shippingHealth(
      {
        last_error: "control plane unreachable: This operation was aborted",
        last_ingest_at: ago(1_000),
      },
      { unshipped: 2296, oldestUnshippedAt: ago(1_000) },
      NOW,
    );
    expect(verdict.healthy).toBe(false);
    expect(verdict.detail).toContain("2296 events waiting");
    expect(verdict.detail).toContain("This operation was aborted");
  });

  it("fails when an old backlog sits and nothing has shipped for the stall window", () => {
    const stale = ago(SHIPPING_STALL_MS + 1_000);
    expect(
      shippingHealth(
        { last_error: null, last_ingest_at: stale },
        { unshipped: 5, oldestUnshippedAt: stale },
        NOW,
      ),
    ).toEqual({
      healthy: false,
      detail: "nothing has shipped in over 10 minutes, 5 events waiting",
    });
    expect(
      shippingHealth(
        { last_error: null, last_ingest_at: null },
        { unshipped: 1, oldestUnshippedAt: stale },
        NOW,
      ).healthy,
    ).toBe(false);
  });

  it("passes while a backlog drains, and while new events wait their first tick", () => {
    expect(
      shippingHealth(
        { last_error: null, last_ingest_at: ago(2_000) },
        { unshipped: 1621, oldestUnshippedAt: ago(86_400_000) },
        NOW,
      ),
    ).toEqual({ healthy: true, detail: "shipping, 1621 events waiting" });
    expect(
      shippingHealth(
        { last_error: null, last_ingest_at: null },
        { unshipped: 1, oldestUnshippedAt: ago(5_000) },
        NOW,
      ).healthy,
    ).toBe(true);
  });
});
