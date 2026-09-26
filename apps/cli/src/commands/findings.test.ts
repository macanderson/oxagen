/**
 * `oxagen findings list`. Pins the wire contract through the apiPostOrThrow
 * seam (route and body, with `runId` only when `--run` is given), the flag
 * validation that refuses before a request leaves the process, and the two
 * output modes (#4001).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiPostOrThrow } = vi.hoisted(() => ({
  apiPostOrThrow: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));

vi.mock("../lib/api.js", async () => {
  const real =
    await vi.importActual<typeof import("../lib/api.js")>("../lib/api.js");
  return { ...real, apiPostOrThrow };
});

import { captureWriter } from "../lib/capture-writer";
import { type FindingListResult, findingsList } from "./findings";

const RUN = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SUBAGENT = "0192d4a8-7c1e-7a00-8000-0000000000bb";

function result(over: Partial<FindingListResult> = {}): FindingListResult {
  return {
    status: "open",
    saving: { micros: "60000", currency: "USD", basis: "gateway_observed" },
    annualised: {
      micros: "730000",
      currency: "USD",
      basis: "gateway_observed",
    },
    counts: { findings: 1, high: 1, medium: 0, operators: 1 },
    findings: [
      {
        id: "fnd_0123456789abcdefghjkmn",
        kind: "repeated_shell_commands",
        subject: "Bash",
        saving: { micros: "60000", currency: "USD", basis: "gateway_observed" },
        confidence: "high",
        runs: 3,
        calls: 9,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  process.exitCode = undefined;
  apiPostOrThrow.mockReset();
});

describe("findings list", () => {
  it("asks for the open findings by default, with no run", async () => {
    apiPostOrThrow.mockResolvedValueOnce(result());
    const c = captureWriter();
    await findingsList({}, c.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("spend/findings", {
      status: "open",
    });
    expect(c.output()).toContain("1 open finding(s): $0.0600 to save");
    expect(c.output()).toContain("repeated_shell_commands");
  });

  it("sends the run and prints the frames each finding cites in it", async () => {
    apiPostOrThrow.mockResolvedValueOnce(
      result({
        findings: [
          {
            ...result().findings[0]!,
            citation: {
              runId: RUN,
              runLevel: false,
              frames: [{ seq: "14" }, { seq: "3", sessionUuid: SUBAGENT }],
              framesTotal: 9,
            },
          },
        ],
      }),
    );
    const c = captureWriter();
    await findingsList({ run: RUN, status: "open" }, c.writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("spend/findings", {
      status: "open",
      runId: RUN,
    });
    expect(c.output()).toContain(`citing ${RUN}`);
    expect(c.output()).toContain("#14, #3 (subagent 0192d4a8) and 7 more");
  });

  it("names a finding about the run's cache as citing the whole run", async () => {
    apiPostOrThrow.mockResolvedValueOnce(
      result({
        findings: [
          {
            ...result().findings[0]!,
            kind: "cache_writes_never_read",
            citation: {
              runId: RUN,
              runLevel: true,
              frames: [],
              framesTotal: 0,
            },
          },
        ],
      }),
    );
    const c = captureWriter();
    await findingsList({ run: RUN }, c.writer);
    expect(c.output()).toContain("the whole run");
  });

  it("says so when no finding cites the run", async () => {
    apiPostOrThrow.mockResolvedValueOnce(
      result({
        findings: [],
        counts: { findings: 0, high: 0, medium: 0, operators: 0 },
      }),
    );
    const c = captureWriter();
    await findingsList({ run: RUN }, c.writer);
    expect(c.output()).toBe(`No open findings citing ${RUN}.`);
  });

  it("emits the contract payload as one JSON line", async () => {
    const payload = result();
    apiPostOrThrow.mockResolvedValueOnce(payload);
    const c = captureWriter();
    await findingsList({ json: true }, c.writer);
    expect(JSON.parse(c.output())).toEqual(payload);
  });

  it("refuses a bad status or run id before any request", async () => {
    const c = captureWriter();
    await findingsList({ status: "closed" }, c.writer);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await findingsList({ run: "run-9" }, c.writer);
    expect(process.exitCode).toBe(2);
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("reports an API failure on stderr with exit 1", async () => {
    apiPostOrThrow.mockRejectedValueOnce(new Error("forbidden"));
    const c = captureWriter();
    await findingsList({}, c.writer);
    expect(process.exitCode).toBe(1);
    expect(c.output()).toContain("forbidden");
  });
});
