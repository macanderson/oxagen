/**
 * resource-monitor.ts — machine-aware concurrency for the fleet.
 *
 * A fixed concurrency cap (4 subagents) is fine on a workstation and ruinous on
 * a laptop already under memory pressure or CPU saturation: too many parallel
 * coding agents thrash swap and starve the interactive REPL. This monitor
 * samples the host every few seconds and derives an EFFECTIVE cap that clamps
 * the configured ceiling down when the machine is struggling — never above the
 * ceiling, never below 1.
 *
 * Two design rules keep it reliable:
 *
 *   1. Injectable seams. `os` (freemem/totalmem/loadavg/availableParallelism)
 *      and the timer are injected, so the clamp table and hysteresis are
 *      unit-testable with no real machine state and no wall-clock waiting —
 *      tests drive readings via {@link ResourceMonitor.sample} directly.
 *   2. Hysteresis. The committed reading only moves to a new pressure band after
 *      TWO consecutive samples agree on it, so a one-sample spike never yanks
 *      concurrency — the value doesn't flap between bands on transient noise.
 *
 * The integrator consumes {@link ResourceMonitor.effectiveConcurrency} from the
 * fleet's `concurrencyProvider` and {@link ResourceMonitor.onChange} to emit a
 * transcript notice when the machine forces a clamp.
 */
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";

/** Coarse machine-pressure band, worst of memory and CPU. */
export type ResourcePressure = "ok" | "elevated" | "critical";

/** One committed reading — what the status line and clamp are derived from. */
export interface ResourceSnapshot {
  /** Free memory as a fraction of total (0..1). */
  freeMemRatio: number;
  /** 1-minute load average. */
  load1: number;
  /** Logical cores available to this process. */
  cores: number;
  /** Worst of the memory and CPU bands. */
  pressure: ResourcePressure;
}

/** The `node:os` surface the monitor depends on — injectable for tests. */
export interface ResourceMonitorOsPort {
  freemem(): number;
  totalmem(): number;
  loadavg(): number[];
  availableParallelism(): number;
}

/** A started timer the monitor can later stop. Mirrors the subset of NodeJS.Timeout used. */
export interface StoppableTimer {
  unref?(): void;
}

export interface ResourceMonitorOptions {
  /** Injected machine-stats port; defaults to `node:os`. */
  os?: ResourceMonitorOsPort;
  /** Sample cadence in ms (default 5000). */
  intervalMs?: number;
  /** Injected timer start; defaults to `setInterval` (unref'd). */
  setIntervalImpl?: (cb: () => void, ms: number) => StoppableTimer;
  /** Injected timer stop; defaults to `clearInterval`. */
  clearIntervalImpl?: (handle: StoppableTimer) => void;
  /**
   * Start the internal timer immediately (default true). Tests pass false and
   * drive readings by calling {@link ResourceMonitor.sample} by hand.
   */
  autoStart?: boolean;
}

export interface ResourceMonitor {
  /**
   * The effective cap for a configured ceiling, from the latest committed
   * reading: clamped down under memory pressure or CPU saturation, never above
   * `configuredCap`, never below 1.
   */
  effectiveConcurrency(configuredCap: number): number;
  /** The latest committed reading (for a status line). */
  snapshot(): ResourceSnapshot;
  /** Subscribe to committed pressure-band changes; returns an unsubscribe fn. */
  onChange(cb: (snap: ResourceSnapshot) => void): () => void;
  /** Take one reading now (also driven by the internal timer). Returns the committed reading. */
  sample(): ResourceSnapshot;
  /**
   * Stop the internal timer AND drop every `onChange` subscriber. Idempotent,
   * and terminal — re-subscribing after `stop()` gets you nothing, because
   * nothing samples any more. `sample()` still works if called by hand.
   */
  stop(): void;
}

/** Free-memory band thresholds (fraction of total). */
const MEM_ELEVATED_BELOW = 0.15;
const MEM_CRITICAL_BELOW = 0.07;
/**
 * CPU-saturation band thresholds (load1 relative to cores). Note that
 * `os.loadavg()` always returns [0, 0, 0] on Windows, so on that platform the
 * CPU band is permanently "ok" and only the memory band can clamp.
 */
const CPU_ELEVATED_FACTOR = 1.25;
const CPU_CRITICAL_FACTOR = 2.0;

const DEFAULT_INTERVAL_MS = 5_000;

const defaultOs: ResourceMonitorOsPort = {
  freemem,
  totalmem,
  loadavg,
  availableParallelism,
};

/** Read the raw machine stats into a snapshot (band classified, no hysteresis). */
function readRaw(os: ResourceMonitorOsPort): ResourceSnapshot {
  const total = os.totalmem();
  const free = os.freemem();
  // A zero/garbage total must not divide-by-zero into NaN — treat as "plenty".
  const freeMemRatio = total > 0 ? clamp01(free / total) : 1;
  const load1 = Math.max(0, os.loadavg()[0] ?? 0);
  const cores = Math.max(1, Math.floor(os.availableParallelism()));

  const memBand: ResourcePressure =
    freeMemRatio < MEM_CRITICAL_BELOW
      ? "critical"
      : freeMemRatio < MEM_ELEVATED_BELOW
        ? "elevated"
        : "ok";
  const cpuBand: ResourcePressure =
    load1 > cores * CPU_CRITICAL_FACTOR
      ? "critical"
      : load1 > cores * CPU_ELEVATED_FACTOR
        ? "elevated"
        : "ok";

  return { freeMemRatio, load1, cores, pressure: worst(memBand, cpuBand) };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

const RANK: Record<ResourcePressure, number> = {
  ok: 0,
  elevated: 1,
  critical: 2,
};
function worst(a: ResourcePressure, b: ResourcePressure): ResourcePressure {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Derive the effective cap from a committed reading. Memory pressure halves the
 * cap (elevated) or pins it to 1 (critical); CPU saturation reduces it
 * proportionally to how far load1 overshoots `cores × 1.25`. The tightest of
 * the constraints wins, clamped to [1, configuredCap].
 */
export function clampConcurrency(
  snap: ResourceSnapshot,
  configuredCap: number,
): number {
  const cap = Math.max(1, Math.floor(configuredCap));

  let memCap = cap;
  if (snap.freeMemRatio < MEM_CRITICAL_BELOW) memCap = 1;
  else if (snap.freeMemRatio < MEM_ELEVATED_BELOW)
    memCap = Math.max(1, Math.floor(cap / 2));

  let cpuCap = cap;
  const cpuBudget = snap.cores * CPU_ELEVATED_FACTOR;
  if (snap.load1 > cpuBudget && snap.load1 > 0) {
    const factor = cpuBudget / snap.load1; // in (0, 1)
    cpuCap = Math.max(1, Math.floor(cap * factor));
  }

  return Math.max(1, Math.min(cap, memCap, cpuCap));
}

export function createResourceMonitor(
  opts: ResourceMonitorOptions = {},
): ResourceMonitor {
  const os = opts.os ?? defaultOs;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startTimer =
    opts.setIntervalImpl ??
    ((cb: () => void, ms: number): StoppableTimer => {
      const handle = setInterval(cb, ms);
      handle.unref?.();
      return handle as unknown as StoppableTimer;
    });
  const stopTimer =
    opts.clearIntervalImpl ??
    ((handle: StoppableTimer): void =>
      clearInterval(handle as unknown as ReturnType<typeof setInterval>));

  const listeners = new Set<(snap: ResourceSnapshot) => void>();
  // Bootstrap the committed reading so effectiveConcurrency has an answer
  // before the first timer tick (a fresh monitor should never clamp to 1
  // just because nothing has sampled yet).
  let committed = readRaw(os);
  // The previous RAW reading, for the two-consecutive-agree hysteresis gate.
  let lastRaw: ResourceSnapshot = committed;
  let timer: StoppableTimer | null = null;
  let stopped = false;

  function sample(): ResourceSnapshot {
    const raw = readRaw(os);
    // Commit only when this raw band matches the previous raw band — two
    // consecutive samples must agree before the committed reading moves. A lone
    // spike (differs from both neighbours) is held off until it's confirmed.
    if (raw.pressure === lastRaw.pressure) {
      const prevBand = committed.pressure;
      committed = raw;
      if (raw.pressure !== prevBand) {
        for (const cb of listeners) {
          try {
            cb(raw);
          } catch {
            // A listener must never break sampling — swallow its throw.
          }
        }
      }
    }
    lastRaw = raw;
    return committed;
  }

  if (opts.autoStart !== false) {
    sample(); // seed with a confirmed first reading
    timer = startTimer(() => void sample(), intervalMs);
  }

  return {
    effectiveConcurrency: (configuredCap: number): number =>
      clampConcurrency(committed, configuredCap),
    snapshot: (): ResourceSnapshot => committed,
    onChange: (cb: (snap: ResourceSnapshot) => void): (() => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    sample,
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) stopTimer(timer);
      timer = null;
      listeners.clear();
    },
  };
}
