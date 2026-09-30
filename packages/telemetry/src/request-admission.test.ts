import { describe, expect, it } from "vitest";
import { createRequestAdmission, MCP_ADMISSION_LANES, sampleProcessMemory } from "./request-admission";

const memory = { heapUsed: 100, heapLimit: 1000, rss: 200, memoryLimit: 2000 };
const lanes = { ingest: { concurrency: 4, reserveBytes: 100 }, control: { concurrency: 2, reserveBytes: 10 } };

describe("request admission", () => {
  it("reserves asset-download headroom before accepting another MCP tool", () => {
    const MiB = 1024 * 1024;
    const gate = createRequestAdmission(MCP_ADMISSION_LANES, () => ({
      heapUsed: 128 * MiB, heapLimit: 768 * MiB,
      rss: 256 * MiB, memoryLimit: 1024 * MiB,
    }));
    const first = gate.acquire("tool");
    expect(first).not.toBeNull();
    // Two 100 MiB downloads can hold both old and grown buffers at once.
    expect(gate.acquire("tool")).toBeNull();
    const control = gate.acquire("control");
    expect(control).not.toBeNull();
    first?.();
    const replacement = gate.acquire("tool");
    expect(replacement).not.toBeNull();
    replacement?.();
    control?.();
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("bounds a 500-machine burst with 30 simultaneous offers per machine", () => {
    const gate = createRequestAdmission(lanes, () => memory);
    const releases = [];
    for (let i = 0; i < 500 * 30; i += 1) {
      const release = gate.acquire("ingest");
      if (release) releases.push(release);
    }
    expect(releases).toHaveLength(4);
    expect(gate.snapshot()).toMatchObject({ admitted: 4, rejected: 14996, reservedBytes: 400 });
    // An ingest burst cannot consume the separate control concurrency slots.
    expect(gate.acquire("control")).not.toBeNull();
    for (const release of releases) { release(); release(); }
    expect(gate.snapshot().active.ingest).toBe(0);
    expect(gate.acquire("ingest")).not.toBeNull();
  });

  it("refuses projected heap and resident-memory pressure and recovers", () => {
    let current = { ...memory, heapUsed: 750 };
    const gate = createRequestAdmission(lanes, () => current);
    expect(gate.acquire("ingest")).toBeNull();
    current = { ...memory, rss: 1650 };
    expect(gate.acquire("ingest")).toBeNull();
    current = { ...memory };
    const release = gate.acquire("ingest");
    expect(release).not.toBeNull();
    release?.();
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("keeps heap protection when the OS has no memory constraint", () => {
    const gate = createRequestAdmission(lanes, () => ({ ...memory, memoryLimit: 0 }));
    expect(gate.acquire("ingest")).not.toBeNull();
    expect(gate.snapshot().ready).toBe(true);
    const full = createRequestAdmission(lanes, () => ({ ...memory, heapUsed: 900 }));
    expect(full.snapshot().ready).toBe(false);
  });

  it("reports heap and native memory without retaining request data", () => {
    const sample = sampleProcessMemory();
    expect(sample.heapLimit).toBeGreaterThan(0);
    expect(sample.heapUsed).toBeGreaterThan(0);
    expect(sample.rss).toBeGreaterThan(0);
    expect(sample.memoryLimit).toBeGreaterThanOrEqual(0);
  });

  it("accounts for every lane against the same projected memory budget", () => {
    const gate = createRequestAdmission({
      large: { concurrency: 8, reserveBytes: 300 },
      small: { concurrency: 8, reserveBytes: 100 },
    }, () => memory);
    const a = gate.acquire("large");
    const b = gate.acquire("large");
    const c = gate.acquire("small");
    expect([a, b, c].every(Boolean)).toBe(true);
    expect(gate.acquire("small")).toBeNull();
    expect(gate.snapshot().reservedBytes).toBe(700);
    a?.();
    a?.();
    const replacement = gate.acquire("large");
    expect(replacement).not.toBeNull();
    b?.();
    c?.();
    replacement?.();
    expect(gate.snapshot().reservedBytes).toBe(0);
  });

  it("recovers all capacity across repeated overload and completion cycles", () => {
    const gate = createRequestAdmission(lanes, () => memory);
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const leases = Array.from({ length: 4 }, () => gate.acquire("ingest"));
      expect(leases.every(Boolean)).toBe(true);
      expect(gate.acquire("ingest")).toBeNull();
      for (const lease of leases) lease?.();
      expect(gate.snapshot().reservedBytes).toBe(0);
    }
    expect(gate.snapshot()).toMatchObject({ admitted: 400, rejected: 100 });
  });
});
