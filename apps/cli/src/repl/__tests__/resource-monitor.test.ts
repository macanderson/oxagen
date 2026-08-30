/**
 * Machine-aware concurrency — proves the clamp table (memory pressure halves /
 * pins to 1, CPU saturation scales proportionally, always within [1, cap]) and
 * the two-consecutive-samples hysteresis that keeps the value from flapping on
 * transient spikes. `os` and the timer are injected — no real machine state,
 * no wall-clock waiting.
 */
import { describe, expect, it, vi } from "vitest";
import {
  clampConcurrency,
  createResourceMonitor,
  type ResourceMonitorOsPort,
  type ResourceSnapshot,
  type StoppableTimer,
} from "../resource-monitor.js";

/** A mutable os stub: memory is set by ratio, load/cores directly. */
function fakeOs(init: { ratio: number; load1: number; cores: number }): {
  os: ResourceMonitorOsPort;
  set: (
    patch: Partial<{ ratio: number; load1: number; cores: number }>,
  ) => void;
} {
  const total = 16_000;
  const state = { ...init };
  return {
    os: {
      totalmem: () => total,
      freemem: () => Math.round(state.ratio * total),
      loadavg: () => [state.load1, 0, 0],
      availableParallelism: () => state.cores,
    },
    set: (patch) => Object.assign(state, patch),
  };
}

const snap = (over: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  freeMemRatio: 0.5,
  load1: 1,
  cores: 8,
  pressure: "ok",
  ...over,
});

describe("clampConcurrency — the clamp table", () => {
  it("leaves the cap untouched when the machine is healthy", () => {
    expect(clampConcurrency(snap(), 4)).toBe(4);
  });

  it("halves the cap under elevated memory pressure (<15% free)", () => {
    expect(clampConcurrency(snap({ freeMemRatio: 0.1 }), 4)).toBe(2);
  });

  it("pins the cap to 1 under critical memory pressure (<7% free)", () => {
    expect(clampConcurrency(snap({ freeMemRatio: 0.05 }), 4)).toBe(1);
  });

  it("reduces proportionally when load overshoots cores × 1.25", () => {
    // cores 4 → budget 5; load 10 → factor 0.5 → floor(4 × 0.5) = 2.
    expect(clampConcurrency(snap({ cores: 4, load1: 10 }), 4)).toBe(2);
  });

  it("drops toward 1 under severe CPU saturation", () => {
    // cores 4 → budget 5; load 20 → factor 0.25 → floor(4 × 0.25) = 1.
    expect(clampConcurrency(snap({ cores: 4, load1: 20 }), 4)).toBe(1);
  });

  it("takes the tightest of the memory and CPU constraints", () => {
    // Elevated mem → memCap 2; mild CPU (budget 5, load 6.25 → factor 0.8 →
    // floor(4×0.8)=3). min(4,2,3) = 2.
    expect(
      clampConcurrency(snap({ freeMemRatio: 0.1, cores: 4, load1: 6.25 }), 4),
    ).toBe(2);
  });

  it("never returns below 1", () => {
    expect(
      clampConcurrency(snap({ freeMemRatio: 0.01, cores: 1, load1: 99 }), 4),
    ).toBe(1);
    expect(clampConcurrency(snap(), 1)).toBe(1);
  });

  it("never returns above the configured cap", () => {
    expect(clampConcurrency(snap({ cores: 64 }), 2)).toBe(2);
  });

  it("floors a fractional cap to an integer", () => {
    expect(clampConcurrency(snap(), 4.9)).toBe(4);
  });
});

describe("createResourceMonitor — hysteresis + effective concurrency", () => {
  it("seeds a committed reading at construction so it never clamps to 1 cold", () => {
    const { os } = fakeOs({ ratio: 0.5, load1: 1, cores: 8 });
    const mon = createResourceMonitor({ os, autoStart: false });
    expect(mon.snapshot().pressure).toBe("ok");
    expect(mon.effectiveConcurrency(4)).toBe(4);
  });

  it("moves to a new band only after two consecutive samples agree", () => {
    const rig = fakeOs({ ratio: 0.5, load1: 1, cores: 8 });
    const mon = createResourceMonitor({ os: rig.os, autoStart: false });

    // One critical sample: not yet confirmed — committed stays ok.
    rig.set({ ratio: 0.05 });
    mon.sample();
    expect(mon.snapshot().pressure).toBe("ok");
    expect(mon.effectiveConcurrency(4)).toBe(4);

    // Second consecutive critical sample: now it commits.
    mon.sample();
    expect(mon.snapshot().pressure).toBe("critical");
    expect(mon.effectiveConcurrency(4)).toBe(1);
  });

  it("does not flap when the band oscillates every sample", () => {
    const rig = fakeOs({ ratio: 0.5, load1: 1, cores: 8 });
    const mon = createResourceMonitor({ os: rig.os, autoStart: false });
    // Alternate ok/critical/ok/critical — no two consecutive samples ever
    // agree, so the committed reading never leaves its seeded "ok" band.
    for (const ratio of [0.05, 0.5, 0.05, 0.5, 0.05]) {
      rig.set({ ratio });
      mon.sample();
    }
    expect(mon.snapshot().pressure).toBe("ok");
    expect(mon.effectiveConcurrency(4)).toBe(4);
  });

  it("fires onChange on a confirmed band transition, and unsubscribes", () => {
    const rig = fakeOs({ ratio: 0.5, load1: 1, cores: 8 });
    const mon = createResourceMonitor({ os: rig.os, autoStart: false });
    const seen: string[] = [];
    const off = mon.onChange((s) => seen.push(s.pressure));

    rig.set({ ratio: 0.1 }); // elevated
    mon.sample(); // 1st — held
    mon.sample(); // 2nd — commits, fires
    expect(seen).toEqual(["elevated"]);

    off();
    rig.set({ ratio: 0.5 }); // back to ok
    mon.sample();
    mon.sample();
    expect(seen).toEqual(["elevated"]); // no further callbacks after unsubscribe
  });

  it("survives a throwing onChange listener", () => {
    const rig = fakeOs({ ratio: 0.5, load1: 1, cores: 8 });
    const mon = createResourceMonitor({ os: rig.os, autoStart: false });
    mon.onChange(() => {
      throw new Error("listener boom");
    });
    rig.set({ ratio: 0.05 });
    expect(() => {
      mon.sample();
      mon.sample();
    }).not.toThrow();
    expect(mon.snapshot().pressure).toBe("critical");
  });

  it("treats a zero total memory as no pressure (no NaN)", () => {
    const os: ResourceMonitorOsPort = {
      totalmem: () => 0,
      freemem: () => 0,
      loadavg: () => [1, 0, 0],
      availableParallelism: () => 4,
    };
    const mon = createResourceMonitor({ os, autoStart: false });
    expect(mon.snapshot().freeMemRatio).toBe(1);
    expect(mon.snapshot().pressure).toBe("ok");
  });

  it("auto-starts a timer that samples, and stop() clears it", () => {
    const rig = fakeOs({ ratio: 0.5, load1: 1, cores: 8 });
    // Held on an object so its type survives the closure assignment (a bare
    // `let` would narrow to `null` at the call sites below).
    const timer: { cb: (() => void) | null } = { cb: null };
    const handle: StoppableTimer = {};
    const setIntervalImpl = vi.fn((cb: () => void) => {
      timer.cb = cb;
      return handle;
    });
    const clearIntervalImpl = vi.fn();
    const mon = createResourceMonitor({
      os: rig.os,
      intervalMs: 5000,
      setIntervalImpl,
      clearIntervalImpl,
    });
    expect(setIntervalImpl).toHaveBeenCalledWith(expect.any(Function), 5000);

    // Drive two ticks of a confirmed transition through the timer callback.
    rig.set({ ratio: 0.05 });
    timer.cb?.();
    timer.cb?.();
    expect(mon.snapshot().pressure).toBe("critical");

    mon.stop();
    expect(clearIntervalImpl).toHaveBeenCalledWith(handle);
    mon.stop(); // idempotent
    expect(clearIntervalImpl).toHaveBeenCalledTimes(1);
  });
});
