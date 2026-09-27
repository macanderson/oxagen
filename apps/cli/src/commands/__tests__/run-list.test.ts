/**
 * `oxagen run list` over `list_runs` (#2950): --json emits the contract
 * payload, pretty mode prints one row per run with a missing agent or cost
 * read as "not recorded", a page with more runs names the cursor to pass, and
 * an API failure goes to stderr. The API client is mocked; no network.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api.js")>()),
  apiPostOrThrow: vi.fn(),
}));
vi.mock("../../lib/config.js", () => ({
  getApiUrl: () => "https://api.example.test",
}));

import { runCostOf, runList, type RunListItem } from "../run.js";
import { apiPostOrThrow } from "../../lib/api.js";

const post = apiPostOrThrow as Mock;

function memoryWriter() {
  const out: string[] = [];
  const err: string[] = [];
  const writer: CommandWriter = {
    write: (line) => {
      out.push(line);
    },
    writeErr: (line) => {
      err.push(line);
    },
  };
  return { writer, out, err };
}

const run = (overrides: Partial<RunListItem> = {}): RunListItem => ({
  id: "tse_0a1b2c",
  agentKey: "acme.core.release-bot",
  status: "live",
  enforcementTier: "harness",
  cost: { micros: "4130000", currency: "USD", basis: "gateway_observed" },
  startedAt: "2026-09-25T09:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
  post.mockReset();
});

describe("oxagen run list", () => {
  it("posts to the runs route with no paging input by default and emits the payload as JSON", async () => {
    const payload = { runs: [run()], nextCursor: null };
    post.mockResolvedValue(payload);
    const { writer, out, err } = memoryWriter();
    await runList({ json: true }, writer);
    expect(post).toHaveBeenCalledWith("runs", {});
    expect(out).toEqual([JSON.stringify(payload)]);
    expect(err).toEqual([]);
  });

  it("passes --limit and --cursor through", async () => {
    post.mockResolvedValue({ runs: [], nextCursor: null });
    const { writer } = memoryWriter();
    await runList({ limit: 25, cursor: "c2" }, writer);
    expect(post).toHaveBeenCalledWith("runs", { limit: 25, cursor: "c2" });
  });

  it("prints one row per run with its id, agent, status, tier, cost and start", async () => {
    post.mockResolvedValue({
      runs: [
        run(),
        run({
          id: "arun_5f0c",
          agentKey: null,
          status: "sealed",
          enforcementTier: "observe",
          cost: null,
        }),
      ],
      nextCursor: null,
    });
    const { writer, out } = memoryWriter();
    await runList({}, writer);
    expect(out[0]).toMatch(/^ID\s+AGENT\s+STATUS\s+TIER\s+COST\s+STARTED\s*$/);
    expect(out[1]).toMatch(
      /^tse_0a1b2c\s+acme\.core\.release-bot\s+live\s+harness\s+\$4\.13\s+2026-09-25T09:00:00\.000Z\s*$/,
    );
    // A run that recorded no agent or cost says so; it never prints a zero.
    expect(out[2]).toMatch(
      /^arun_5f0c\s+not recorded\s+sealed\s+observe\s+not recorded\s+/,
    );
    expect(out).toHaveLength(3);
  });

  it("names the cursor to pass when the page stopped before the oldest run", async () => {
    post.mockResolvedValue({ runs: [run()], nextCursor: "cur_next" });
    const { writer, out } = memoryWriter();
    await runList({}, writer);
    expect(out.at(-1)).toBe(
      "More runs: pass --cursor cur_next for the next page.",
    );
  });

  it("names the enroll command on an empty workspace, and says the pages ran out on a later empty page", async () => {
    post.mockResolvedValue({ runs: [], nextCursor: null });
    const first = memoryWriter();
    await runList({}, first.writer);
    expect(first.out.join("\n")).toContain("oxagen agent enroll");
    const later = memoryWriter();
    await runList({ cursor: "c9" }, later.writer);
    expect(later.out).toEqual(["No more runs."]);
  });

  it("reports an API failure on stderr and prints no table (negative)", async () => {
    post.mockRejectedValue(new Error("forbidden"));
    const { writer, out, err } = memoryWriter();
    const exitCode = process.exitCode;
    await runList({}, writer);
    process.exitCode = exitCode;
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("forbidden");
  });
});

describe("runCostOf", () => {
  it("prints dollars for USD, the amount and currency otherwise, and not recorded for none", () => {
    expect(
      runCostOf({
        micros: "1250000",
        currency: "USD",
        basis: "gateway_observed",
      }),
    ).toBe("$1.25");
    expect(
      runCostOf({
        micros: "1250000",
        currency: "EUR",
        basis: "gateway_observed",
      }),
    ).toBe("1.25 EUR");
    expect(runCostOf(null)).toBe("not recorded");
  });
});
