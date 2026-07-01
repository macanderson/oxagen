/**
 * BackgroundMonitorService (Group 5). Proves the hard requirements:
 *
 *   1. `dispatch` returns control immediately — it resolves without waiting
 *      for the target's terminal state, even against a poller that never
 *      settles.
 *   2. A failing run produces a report carrying the failure fix-assessment,
 *      correctly derived from whether the poller identified the problem AND
 *      whether committed changes exist.
 *   3. Reports fire only on the terminal state (exactly once per dispatch),
 *      never per poll.
 *   4. The dispatch and report debug lines match `monitor-tools.json -> logging`.
 *   5. A transient poll failure is retried after the configured interval,
 *      without ever calling the real timer machinery in the deterministic path.
 *
 * The poller, log sink, id generator, and clock are all injected so nothing
 * here touches the filesystem, the network, or a real timer.
 */
import { describe, it, expect, vi } from "vitest";
import { BackgroundMonitorService } from "../monitor-service.js";
import type {
  MonitorDispatchInput,
  MonitorLogEntry,
  MonitorReport,
  TargetPollResult,
} from "../index.js";

/** A poller resolved via an externally-controlled deferred promise. */
function deferredPoller(): {
  poll: (input: MonitorDispatchInput, signal: AbortSignal) => Promise<TargetPollResult>;
  resolve: (result: TargetPollResult) => void;
  reject: (err: unknown) => void;
} {
  let resolveFn!: (result: TargetPollResult) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<TargetPollResult>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { poll: () => promise, resolve: resolveFn, reject: rejectFn };
}

/** Flush pending microtasks so `void`-fired async work has a chance to run. */
async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const baseInput: MonitorDispatchInput = {
  targetType: "gh_actions_run",
  targetId: "run-1",
};

describe("dispatch never blocks", () => {
  it("resolves immediately, before the poller ever settles", async () => {
    const { poll } = deferredPoller(); // never resolves in this test
    const log = vi.fn();
    const service = new BackgroundMonitorService({ poll, log, genId: () => "mon_fixed" });
    const reports: MonitorReport[] = [];
    service.onReport((r) => reports.push(r));

    const result = await service.dispatch(baseInput);

    expect(result).toEqual({ subagentId: "mon_fixed", background: true });
    // No report should have arrived — the poller never settled.
    await flushMicrotasks();
    expect(reports).toHaveLength(0);
  });

  it("resolves immediately even against a poller that eventually never terminates", async () => {
    const slowPoll = vi.fn(() => new Promise<TargetPollResult>(() => {})); // never settles
    const service = new BackgroundMonitorService({ poll: slowPoll, log: vi.fn() });

    const start = Date.now();
    const result = await service.dispatch(baseInput);
    const elapsed = Date.now() - start;

    expect(result.background).toBe(true);
    expect(typeof result.subagentId).toBe("string");
    expect(elapsed).toBeLessThan(50);
  });
});

describe("terminal-state reporting", () => {
  it("reports success with no fix-assessment fields", async () => {
    const { poll, resolve } = deferredPoller();
    const log = vi.fn();
    const service = new BackgroundMonitorService({ poll, log, genId: () => "mon_ok" });
    const reports: MonitorReport[] = [];
    service.onReport((r) => reports.push(r));

    await service.dispatch(baseInput);
    resolve({ status: "succeeded" });
    await flushMicrotasks();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({ targetId: "run-1", status: "succeeded" });
  });

  it("reports failure with identifiedProblem + canFixWithCommittedChanges true when both hold", async () => {
    const { poll, resolve } = deferredPoller();
    const service = new BackgroundMonitorService({ poll, log: vi.fn() });
    const reports: MonitorReport[] = [];
    service.onReport((r) => reports.push(r));

    await service.dispatch({ ...baseInput, committedChangeRefs: ["abc123"] });
    resolve({ status: "failed", identifiedProblem: true, note: "flaky network call" });
    await flushMicrotasks();

    expect(reports[0]).toEqual({
      targetId: "run-1",
      status: "failed",
      identifiedProblem: true,
      canFixWithCommittedChanges: true,
      note: "flaky network call",
    });
  });

  it("canFixWithCommittedChanges is false when the problem was identified but nothing was committed", async () => {
    const { poll, resolve } = deferredPoller();
    const service = new BackgroundMonitorService({ poll, log: vi.fn() });
    const reports: MonitorReport[] = [];
    service.onReport((r) => reports.push(r));

    await service.dispatch(baseInput); // no committedChangeRefs
    resolve({ status: "failed", identifiedProblem: true });
    await flushMicrotasks();

    expect(reports[0]?.identifiedProblem).toBe(true);
    expect(reports[0]?.canFixWithCommittedChanges).toBe(false);
  });

  it("canFixWithCommittedChanges is false when changes exist but the problem was not identified", async () => {
    const { poll, resolve } = deferredPoller();
    const service = new BackgroundMonitorService({ poll, log: vi.fn() });
    const reports: MonitorReport[] = [];
    service.onReport((r) => reports.push(r));

    await service.dispatch({ ...baseInput, committedChangeRefs: ["abc123"] });
    resolve({ status: "failed", identifiedProblem: false, note: "unclear failure" });
    await flushMicrotasks();

    expect(reports[0]).toEqual({
      targetId: "run-1",
      status: "failed",
      identifiedProblem: false,
      canFixWithCommittedChanges: false,
      note: "unclear failure",
    });
  });

  it("invokes every registered handler exactly once, never per poll", async () => {
    const { poll, resolve } = deferredPoller();
    const service = new BackgroundMonitorService({ poll, log: vi.fn() });
    const a = vi.fn();
    const b = vi.fn();
    service.onReport(a);
    service.onReport(b);

    await service.dispatch(baseInput);
    resolve({ status: "succeeded" });
    await flushMicrotasks();
    resolve({ status: "succeeded" }); // resolving again is a no-op on an already-settled promise

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("debug logging", () => {
  it("logs the dispatch line the instant dispatch resolves", async () => {
    const { poll } = deferredPoller();
    const log = vi.fn();
    const service = new BackgroundMonitorService({
      poll,
      log,
      genId: () => "mon_log",
      nowIso: () => "2026-07-01T00:00:00.000Z",
    });

    await service.dispatch({ targetType: "pull_request", targetId: "77" });

    expect(log).toHaveBeenCalledWith({
      kind: "dispatch",
      targetType: "pull_request",
      targetId: "77",
      subagentId: "mon_log",
      at: "2026-07-01T00:00:00.000Z",
    } satisfies MonitorLogEntry);
  });

  it("logs the report line only after the terminal state, carrying the subagentId", async () => {
    const { poll, resolve } = deferredPoller();
    const log = vi.fn();
    const service = new BackgroundMonitorService({
      poll,
      log,
      genId: () => "mon_report",
      nowIso: () => "2026-07-01T00:00:05.000Z",
    });

    await service.dispatch({ targetType: "ci_job", targetId: "j1", committedChangeRefs: ["c1"] });
    expect(log).toHaveBeenCalledTimes(1); // only the dispatch line so far

    resolve({ status: "failed", identifiedProblem: true, note: "lint failure" });
    await flushMicrotasks();

    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(2, {
      kind: "report",
      targetType: "ci_job",
      targetId: "j1",
      status: "failed",
      identifiedProblem: true,
      canFixWithCommittedChanges: true,
      note: "lint failure",
      subagentId: "mon_report",
      at: "2026-07-01T00:00:05.000Z",
    } satisfies MonitorLogEntry);
  });
});

describe("transient poll failures", () => {
  it("retries after the configured interval and reports once the retry succeeds", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const poll = vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("network blip");
        return { status: "succeeded" as const };
      });
      const service = new BackgroundMonitorService({
        poll,
        log: vi.fn(),
        genId: () => "mon_retry",
      });
      const reports: MonitorReport[] = [];
      service.onReport((r) => reports.push(r));

      await service.dispatch({ ...baseInput, pollIntervalSeconds: 1 });
      // Let the first (failing) attempt run and schedule its retry timer.
      await flushMicrotasks();
      expect(poll).toHaveBeenCalledTimes(1);
      expect(reports).toHaveLength(0);

      // Advance past the 1-second retry interval.
      await vi.advanceTimersByTimeAsync(1000);

      expect(poll).toHaveBeenCalledTimes(2);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toEqual({ targetId: "run-1", status: "succeeded" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("default id generator", () => {
  it("produces a subagentId when none is injected", async () => {
    const { poll } = deferredPoller();
    const service = new BackgroundMonitorService({ poll, log: vi.fn() });
    const result = await service.dispatch(baseInput);
    expect(result.subagentId).toMatch(/^mon_/);
    expect(result.background).toBe(true);
  });
});
