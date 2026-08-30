// cli.test.ts — the internal argv-dispatching entry point (list/replay).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handleBenchListMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const handleBenchReplayMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const closeClickhouseMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock("./commands", () => ({
  handleBenchList: handleBenchListMock,
  handleBenchReplay: handleBenchReplayMock,
}));
vi.mock("@oxagen/telemetry", () => ({
  closeClickhouse: closeClickhouseMock,
  // `cli.ts` calls this at module load to decide whether it was run directly;
  // under vitest it must be a no-op guard (never the direct entry).
  isDirectRunEntry: () => false,
}));

describe("parseFlags", () => {
  it("collects --key value pairs, boolean flags, -n as an alias for --limit, and positionals", async () => {
    const { parseFlags } = await import("./cli");
    const { positional, flags } = parseFlags([
      "2984",
      "--run",
      "--type",
      "swe-bench",
      "-n",
      "10",
      "--json",
    ]);
    expect(positional).toEqual(["2984"]);
    expect(flags).toEqual({
      run: true,
      type: "swe-bench",
      limit: "10",
      json: true,
    });
  });

  it("treats a flag followed by another flag as a boolean (no value to consume)", async () => {
    const { parseFlags } = await import("./cli");
    const { flags } = parseFlags(["--run", "--json"]);
    expect(flags).toEqual({ run: true, json: true });
  });

  it("returns empty positional/flags for an empty argv", async () => {
    const { parseFlags } = await import("./cli");
    expect(parseFlags([])).toEqual({ positional: [], flags: {} });
  });
});

describe("main", () => {
  let errOut: string;
  let writeErr: typeof process.stderr.write;

  beforeEach(() => {
    errOut = "";
    writeErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      errOut += s;
      return true;
    }) as typeof process.stderr.write;
    process.exitCode = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.stderr.write = writeErr;
    process.exitCode = 0;
  });

  it("dispatches 'list' with parsed type/limit/json", async () => {
    const { main } = await import("./cli");
    await main(["list", "--type", "swe-bench", "-n", "5", "--json"]);
    expect(handleBenchListMock).toHaveBeenCalledWith({
      type: "swe-bench",
      limit: "5",
      json: true,
    });
  });

  it("dispatches 'replay' with the positional public_id and --run/--json", async () => {
    const { main } = await import("./cli");
    await main(["replay", "2984", "--run"]);
    expect(handleBenchReplayMock).toHaveBeenCalledWith("2984", {
      run: true,
      json: false,
    });
  });

  it("prints a usage error and sets exit code 1 for an unrecognised subcommand", async () => {
    const { main } = await import("./cli");
    await main(["bogus"]);
    expect(errOut).toContain("Usage:");
    expect(process.exitCode).toBe(1);
    expect(handleBenchListMock).not.toHaveBeenCalled();
    expect(handleBenchReplayMock).not.toHaveBeenCalled();
  });

  it("prints a usage error when no subcommand is given", async () => {
    const { main } = await import("./cli");
    await main([]);
    expect(errOut).toContain("Usage:");
    expect(process.exitCode).toBe(1);
  });
});
