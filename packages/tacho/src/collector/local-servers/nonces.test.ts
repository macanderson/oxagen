import { describe, expect, it } from "vitest";
import { createNonceLedger } from "./nonces";

describe("createNonceLedger", () => {
  it("holds a nonce until its expiry plus the skew", () => {
    const ledger = createNonceLedger({ skewMs: 5_000 });
    ledger.remember("n1", 10_000, 0);
    expect(ledger.seen("n1", 14_999)).toBe(true);
    expect(ledger.size()).toBe(1);
    expect(ledger.seen("n1", 15_000)).toBe(false);
    expect(ledger.size()).toBe(0);
  });

  it("has not seen a nonce it never held", () => {
    const ledger = createNonceLedger({ skewMs: 0 });
    expect(ledger.seen("n1", 0)).toBe(false);
  });

  it("prunes lapsed nonces when it remembers a new one", () => {
    const ledger = createNonceLedger({ skewMs: 0 });
    ledger.remember("old", 100, 0);
    ledger.remember("kept", 1_000, 0);
    ledger.remember("new", 2_000, 500);
    expect(ledger.size()).toBe(2);
    expect(ledger.seen("old", 500)).toBe(false);
    expect(ledger.seen("kept", 500)).toBe(true);
  });
});
