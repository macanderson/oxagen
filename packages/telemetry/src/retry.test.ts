// Unit tests for retryWithBackoff(). This helper backs durable writes for
// security-audit events (security.ts) and the IAM tamper-evident audit chain
// (@oxagen/iam emit-audit.ts): a transient DB/ClickHouse failure must be
// retried before a caller treats the write as dropped.

import { describe, expect, it, vi } from "vitest";
import { retryWithBackoff } from "./retry";

describe("retryWithBackoff", () => {
  it("resolves with the first successful result without retrying", async () => {
    const fn = vi.fn(() => Promise.resolve("ok"));

    await expect(retryWithBackoff(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a failing fn and resolves once it succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      return calls < 3
        ? Promise.reject(new Error(`fail ${calls}`))
        : Promise.resolve("recovered");
    });

    await expect(
      retryWithBackoff(fn, { attempts: 3, baseDelayMs: 5 }),
    ).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows the LAST error once every attempt is exhausted", async () => {
    const errors = [
      new Error("first"),
      new Error("second"),
      new Error("third — the last one"),
    ];
    let call = 0;
    const fn = vi.fn(() => Promise.reject(errors[call++]));

    await expect(
      retryWithBackoff(fn, { attempts: 3, baseDelayMs: 5 }),
    ).rejects.toThrow("third — the last one");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("uses the default attempts (3) and baseDelayMs (25ms) when no options are passed", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("always fails")));

    await expect(retryWithBackoff(fn)).rejects.toThrow("always fails");
    // Default attempts = 3.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects a custom attempts count (single attempt = no retry)", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("one shot")));

    await expect(retryWithBackoff(fn, { attempts: 1 })).rejects.toThrow(
      "one shot",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
