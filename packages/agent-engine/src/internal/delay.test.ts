/**
 * The abortable sleep.
 *
 * Moved here with `delay` when the TypeScript step loop was deleted; tools.ts
 * and the evaluator are what use it now.
 */
import { describe, it, expect } from "vitest";
import { delay } from "./delay";

describe("delay", () => {
  it("rejects with AbortError when the signal fires", async () => {
    const ac = new AbortController();
    const p = delay(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves immediately for ms<=0", async () => {
    await expect(delay(0)).resolves.toBeUndefined();
  });

  it("rejects immediately when the signal is ALREADY aborted (never waits the full duration)", async () => {
    // addEventListener('abort') does not fire for an abort dispatched before the
    // listener is attached, so without an up-front `signal.aborted` guard an
    // already-aborted signal would wait the full `ms`. Assert it rejects fast.
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    await expect(delay(10_000, ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    // Rejected essentially instantly, not after ~10s.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
