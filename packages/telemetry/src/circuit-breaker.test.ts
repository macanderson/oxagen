import { describe, it, expect, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  isCircuitOpenError,
  getBreaker,
  __resetBreakerRegistry,
  type BreakerTransition,
} from "./circuit-breaker";

/** A controllable clock so tests never rely on wall time. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const ok = () => Promise.resolve("ok");
const boom = () => Promise.reject(new Error("dependency down"));
/** Intentionally a non-Error rejection — exercises the `String(err)` fallback arm. */
const boomNonError = () => Promise.reject("plain string failure");

describe("CircuitBreaker", () => {
  it("stays closed and passes through while calls succeed", async () => {
    const b = new CircuitBreaker("k", { failureThreshold: 3 });
    for (let i = 0; i < 10; i++) expect(await b.exec(ok)).toBe("ok");
    expect(b.getState()).toBe("closed");
  });

  it("trips open after exactly failureThreshold consecutive failures", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker("k", { failureThreshold: 3, now: clock.now });

    // 2 failures — still closed (below threshold).
    await expect(b.exec(boom)).rejects.toThrow("dependency down");
    await expect(b.exec(boom)).rejects.toThrow("dependency down");
    expect(b.getState()).toBe("closed");

    // 3rd failure trips it open.
    await expect(b.exec(boom)).rejects.toThrow("dependency down");
    expect(b.getState()).toBe("open");

    // Now it fails FAST with a distinguishable error — fn is not even invoked.
    const fn = vi.fn(boom);
    await expect(b.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("a success in closed state resets the failure count", async () => {
    const b = new CircuitBreaker("k", { failureThreshold: 3 });
    await expect(b.exec(boom)).rejects.toThrow();
    await expect(b.exec(boom)).rejects.toThrow();
    await b.exec(ok); // resets
    // Two more failures should NOT trip (count was reset, threshold is 3).
    await expect(b.exec(boom)).rejects.toThrow();
    await expect(b.exec(boom)).rejects.toThrow();
    expect(b.getState()).toBe("closed");
  });

  it("half-opens after the reset timeout and closes on a probe success", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker("k", {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      successThreshold: 1,
      now: clock.now,
    });
    await expect(b.exec(boom)).rejects.toThrow(); // trips open
    expect(b.getState()).toBe("open");

    // Before the window elapses: still fails fast.
    clock.advance(999);
    await expect(b.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);

    // After the window: the next call is a probe; success closes the breaker.
    clock.advance(1);
    expect(await b.exec(ok)).toBe("ok");
    expect(b.getState()).toBe("closed");
  });

  it("getState() surfaces a matured open→half-open transition without a call", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker("k", {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: clock.now,
    });
    await expect(b.exec(boom)).rejects.toThrow(); // trips open
    expect(b.getState()).toBe("open");

    // Advance past the reset window WITHOUT calling exec() — getState() must
    // report "half-open" purely from reading the clock, for observability/UI
    // reads that shouldn't themselves trigger a probe.
    clock.advance(1000);
    expect(b.getState()).toBe("half-open");
  });

  it("reset() forces the breaker back to a healthy closed state", async () => {
    const b = new CircuitBreaker("k", { failureThreshold: 1 });
    await expect(b.exec(boom)).rejects.toThrow(); // trips open
    expect(b.getState()).toBe("open");

    b.reset();
    expect(b.getState()).toBe("closed");
    // Failure count was cleared too — it takes a fresh failureThreshold hits
    // to trip again rather than immediately re-opening.
    expect(await b.exec(ok)).toBe("ok");
    expect(b.getState()).toBe("closed");
  });

  it("stringifies a non-Error rejection in the transition's error field", async () => {
    const transitions: BreakerTransition[] = [];
    const b = new CircuitBreaker("k", {
      failureThreshold: 1,
      onTransition: (t) => transitions.push(t),
    });
    await expect(b.exec(boomNonError)).rejects.toBe("plain string failure");
    expect(b.getState()).toBe("open");
    expect(transitions[0]?.error).toBe("plain string failure");
  });

  it("re-opens immediately when the half-open probe fails", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker("k", {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: clock.now,
    });
    await expect(b.exec(boom)).rejects.toThrow(); // open
    clock.advance(1000);
    // Probe fails → straight back to open, and the window restarts.
    await expect(b.exec(boom)).rejects.toThrow("dependency down");
    expect(b.getState()).toBe("open");
    await expect(b.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("requires successThreshold consecutive probe successes to close", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker("k", {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      successThreshold: 2,
      now: clock.now,
    });
    await expect(b.exec(boom)).rejects.toThrow();
    clock.advance(1000);
    // First probe succeeds but breaker is not closed yet (needs 2).
    expect(await b.exec(ok)).toBe("ok");
    expect(b.getState()).toBe("half-open");
    // Second success closes it.
    expect(await b.exec(ok)).toBe("ok");
    expect(b.getState()).toBe("closed");
  });

  it("emits transitions to onTransition with from/to/failureCount", async () => {
    const clock = fakeClock();
    const transitions: BreakerTransition[] = [];
    const b = new CircuitBreaker("neo4j", {
      failureThreshold: 2,
      resetTimeoutMs: 500,
      now: clock.now,
      onTransition: (t) => transitions.push(t),
    });
    await expect(b.exec(boom)).rejects.toThrow();
    await expect(b.exec(boom)).rejects.toThrow(); // trips
    clock.advance(500);
    await b.exec(ok); // half-open probe → closed

    expect(transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      "closed->open",
      "open->half-open",
      "half-open->closed",
    ]);
    expect(transitions[0]).toMatchObject({
      key: "neo4j",
      failureCount: 2,
      error: "dependency down",
    });
  });

  it("never lets a throwing onTransition sink destabilise the breaker", async () => {
    const b = new CircuitBreaker("k", {
      failureThreshold: 1,
      onTransition: () => {
        throw new Error("telemetry exploded");
      },
    });
    // The dependency error propagates; the sink's throw is swallowed.
    await expect(b.exec(boom)).rejects.toThrow("dependency down");
    expect(b.getState()).toBe("open");
  });
});

describe("getBreaker registry (per-key isolation)", () => {
  it("returns the same instance for a key and isolates distinct keys", async () => {
    __resetBreakerRegistry();
    const a1 = getBreaker("depA", { failureThreshold: 1 });
    const a2 = getBreaker("depA");
    expect(a1).toBe(a2); // same process-wide instance

    const bKey = getBreaker("depB", { failureThreshold: 1 });
    // Trip depA only.
    await expect(a1.exec(boom)).rejects.toThrow();
    expect(a1.getState()).toBe("open");
    // depB is unaffected — a down dependency must not fail-fast an unrelated one.
    expect(bKey.getState()).toBe("closed");
    expect(await bKey.exec(ok)).toBe("ok");
  });
});

describe("isCircuitOpenError", () => {
  it("identifies the fail-fast error and its stable code", () => {
    const err = new CircuitOpenError("stripe", 1234);
    expect(isCircuitOpenError(err)).toBe(true);
    expect(err.code).toBe("CIRCUIT_OPEN");
    expect(err.retryAfterMs).toBe(1234);
    expect(isCircuitOpenError(new Error("other"))).toBe(false);
  });
});

/**
 * #1393's repro. The existing suite drives the state machine sequentially,
 * which is why this was invisible: every assertion above still passes against
 * the broken breaker. Concurrency is the normal condition for a breaker — a
 * single-threaded caller would not need one.
 */
describe("half-open admits ONE probe (#1393)", () => {
  /** A dependency that counts arrivals and settles only when told to. */
  function gatedDependency() {
    let arrivals = 0;
    const settle: Array<(value: string) => void> = [];
    const reject: Array<(err: unknown) => void> = [];
    return {
      get arrivals() {
        return arrivals;
      },
      call: () =>
        new Promise<string>((resolveCall, rejectCall) => {
          arrivals += 1;
          settle.push(resolveCall);
          reject.push(rejectCall);
        }),
      settleAll: () => {
        for (const r of settle.splice(0)) r("ok");
        reject.splice(0);
      },
      failAll: () => {
        for (const r of reject.splice(0)) r(new Error("dependency down"));
        settle.splice(0);
      },
    };
  }

  /** Trip the breaker open, then advance past the reset window. */
  async function openedBreaker(clock: ReturnType<typeof fakeClock>) {
    const b = new CircuitBreaker("k", {
      failureThreshold: 2,
      resetTimeoutMs: 1000,
      now: clock.now,
    });
    await expect(b.exec(boom)).rejects.toThrow();
    await expect(b.exec(boom)).rejects.toThrow();
    expect(b.getState()).toBe("open");
    clock.advance(1001);
    return b;
  }

  it("lets exactly one of twenty concurrent callers reach the dependency", async () => {
    const clock = fakeClock();
    const b = await openedBreaker(clock);
    const dep = gatedDependency();

    const calls = Array.from({ length: 20 }, () =>
      b.exec(dep.call).catch((err: unknown) => err),
    );
    // Let the probe claim the slot and the other nineteen shed.
    await Promise.resolve();

    // Before the fix this was 20.
    expect(dep.arrivals).toBe(1);

    dep.settleAll();
    const results = await Promise.all(calls);
    const shed = results.filter((r) => isCircuitOpenError(r));
    expect(shed).toHaveLength(19);
  });

  it("frees the slot once the probe settles", async () => {
    const clock = fakeClock();
    const b = await openedBreaker(clock);
    const dep = gatedDependency();

    const first = b.exec(dep.call);
    await Promise.resolve();
    await expect(b.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);

    dep.settleAll();
    await first;
    // The probe succeeded, so the breaker closed and traffic flows again.
    expect(b.getState()).toBe("closed");
    expect(await b.exec(ok)).toBe("ok");
  });

  it("reopens on a failed probe without letting the shed callers through", async () => {
    const clock = fakeClock();
    const b = await openedBreaker(clock);
    const dep = gatedDependency();

    const probe = b.exec(dep.call);
    await Promise.resolve();
    const shed = b.exec(dep.call).catch((err: unknown) => err);

    dep.failAll();
    await expect(probe).rejects.toThrow("dependency down");
    expect(await shed).toBeInstanceOf(CircuitOpenError);
    expect(dep.arrivals).toBe(1);
    expect(b.getState()).toBe("open");
  });

  it("means successThreshold > 1 is N SEQUENTIAL probes", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker("k", {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      successThreshold: 2,
      now: clock.now,
    });
    await expect(b.exec(boom)).rejects.toThrow();
    clock.advance(1001);

    const dep = gatedDependency();
    const first = b.exec(dep.call);
    await Promise.resolve();
    // A concurrent second call cannot be the second probe.
    await expect(b.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    dep.settleAll();
    await first;
    expect(b.getState()).toBe("half-open");

    // Sequentially, it can.
    expect(await b.exec(ok)).toBe("ok");
    expect(b.getState()).toBe("closed");
  });

  it("does not gate ordinary traffic while closed", async () => {
    const b = new CircuitBreaker("k", { failureThreshold: 3 });
    const dep = gatedDependency();
    const calls = Array.from({ length: 5 }, () => b.exec(dep.call));
    await Promise.resolve();
    expect(dep.arrivals).toBe(5);
    dep.settleAll();
    await Promise.all(calls);
  });

  /**
   * The gate needs a deadline of its own: a probe that never settles would
   * otherwise hold it forever, leaving a recovered dependency shut out with
   * silence as the only symptom.
   */
  it("lets another caller take over a probe that outlived its deadline", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker("k", {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      probeTimeoutMs: 5000,
      now: clock.now,
    });
    await expect(b.exec(boom)).rejects.toThrow();
    clock.advance(1001);

    const dep = gatedDependency();
    void b.exec(dep.call).catch(() => undefined); // the probe that hangs
    await Promise.resolve();
    expect(dep.arrivals).toBe(1);

    // Still inside the deadline — shed.
    clock.advance(4000);
    await expect(b.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);

    // Past it — the next caller becomes the probe.
    clock.advance(1001);
    expect(await b.exec(ok)).toBe("ok");
    expect(b.getState()).toBe("closed");
  });

  it("ignores a presumed-lost probe that settles after being replaced", async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker("k", {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      probeTimeoutMs: 5000,
      now: clock.now,
    });
    await expect(b.exec(boom)).rejects.toThrow();
    clock.advance(1001);

    const dep = gatedDependency();
    const lost = b.exec(dep.call).catch((err: unknown) => err);
    await Promise.resolve();

    clock.advance(5001);
    expect(await b.exec(ok)).toBe("ok");
    expect(b.getState()).toBe("closed");

    // The abandoned probe now fails — it must not reopen a breaker it no
    // longer speaks for.
    dep.failAll();
    await lost;
    expect(b.getState()).toBe("closed");
  });
});
