import { getHeapStatistics } from "node:v8";

const MiB = 1024 * 1024;

export interface MemorySample {
  heapUsed: number;
  heapLimit: number;
  rss: number;
  memoryLimit: number;
}

export function sampleProcessMemory(): MemorySample {
  const { heapUsed, rss } = process.memoryUsage();
  return {
    heapUsed,
    rss,
    heapLimit: getHeapStatistics().heap_size_limit,
    memoryLimit: process.constrainedMemory(),
  };
}

export interface AdmissionLane {
  concurrency: number;
  reserveBytes: number;
}

/** No waiting promises or request bodies accumulate behind this gate. */
export function createRequestAdmission<L extends string>(
  lanes: Record<L, AdmissionLane>,
  sample: () => MemorySample = sampleProcessMemory,
) {
  const active = new Map<L, number>();
  let reservedBytes = 0;
  let rejected = 0;
  let admitted = 0;

  function pressure(reserveBytes: number): boolean {
    const memory = sample();
    // Reserve for allocations that admitted work has not made yet. Counting
    // allocations already made twice trades utilization for crash headroom.
    return (
      memory.heapUsed + reservedBytes + reserveBytes > memory.heapLimit * 0.8 ||
      (memory.memoryLimit > 0 &&
        memory.rss + reservedBytes + reserveBytes > memory.memoryLimit * 0.85)
    );
  }

  return {
    acquire(lane: L): (() => void) | null {
      const limits = lanes[lane];
      const count = active.get(lane) ?? 0;
      if (count >= limits.concurrency || pressure(limits.reserveBytes)) {
        rejected += 1;
        return null;
      }
      active.set(lane, count + 1);
      reservedBytes += limits.reserveBytes;
      admitted += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active.set(lane, (active.get(lane) ?? 1) - 1);
        reservedBytes -= limits.reserveBytes;
      };
    },
    snapshot() {
      return {
        active: Object.fromEntries(active),
        reservedBytes,
        admitted,
        rejected,
        memory: sample(),
        ready: !pressure(0),
      };
    },
  };
}

export const API_ADMISSION_LANES = {
  control: { concurrency: 8, reserveBytes: 32 * MiB },
  ingest: { concurrency: 4, reserveBytes: 32 * MiB },
  background: { concurrency: 2, reserveBytes: 64 * MiB },
  interactive: { concurrency: 16, reserveBytes: 32 * MiB },
  upload: { concurrency: 1, reserveBytes: 256 * MiB },
} as const;

export const MCP_ADMISSION_LANES = {
  control: { concurrency: 8, reserveBytes: 32 * MiB },
  // Tool names arrive after admission. Reserve for a 100 MiB asset download
  // and its growing buffer even when a request eventually calls a small tool.
  tool: { concurrency: 4, reserveBytes: 256 * MiB },
} as const;
