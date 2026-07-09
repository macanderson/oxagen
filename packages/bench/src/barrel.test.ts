// barrel.test.ts
//
// Smoke-tests that index.ts re-exports the expected public symbols, and
// exercises the barrel file itself so it's not a permanent 0%-coverage gap.

import { describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/telemetry", () => ({
  clickhouse: () => ({ close: vi.fn(), insert: vi.fn(), query: vi.fn() }),
  closeClickhouse: vi.fn(),
}));

describe("index.ts barrel exports", () => {
  // The barrel transitively imports the whole package graph; on a loaded CI
  // runner that first import can exceed vitest's 5s default (observed flake).
  it("exports the expected public symbols", { timeout: 30_000 }, async () => {
    const mod = await import("./index");
    // Ingestion
    expect(typeof mod.ingestBenchResultsDir).toBe("function");
    expect(typeof mod.insertBenchmarkRun).toBe("function");
    expect(typeof mod.insertBenchmarkRunResults).toBe("function");
    expect(typeof mod.insertBenchmarkCandidates).toBe("function");
    // Query
    expect(typeof mod.listBenchResults).toBe("function");
    expect(typeof mod.getBenchResultByPublicId).toBe("function");
    expect(typeof mod.getBenchRunByPublicId).toBe("function");
    expect(typeof mod.getBenchCandidatesForResult).toBe("function");
    // Replay
    expect(typeof mod.buildReplayEnv).toBe("function");
    expect(typeof mod.runScriptFor).toBe("function");
    expect(typeof mod.formatEnvPrefix).toBe("function");
    // Secrets guard
    expect(typeof mod.assertNoSecretValues).toBe("function");
    // Harbor parsing
    expect(typeof mod.parseTrajectory).toBe("function");
    expect(typeof mod.parseVerifierReport).toBe("function");
    expect(typeof mod.agentNameFromHarborConfig).toBe("function");
    // Types (BENCH_TOOL_NAMES is a runtime const, not just a type)
    expect(Array.isArray(mod.BENCH_TOOL_NAMES)).toBe(true);
  });
});
