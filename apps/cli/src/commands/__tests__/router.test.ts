/**
 * `oxagen router …` output-discipline tests. Mocks the shared API client so no
 * network is needed; asserts --json emits the exact contract payload, pretty
 * mode renders tables/summaries, and API failures route to stderr.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", () => ({
  apiGetOrThrow: vi.fn(),
  apiPostOrThrow: vi.fn(),
  printTable: vi.fn(
    (
      headers: string[],
      rows: string[][],
      writer: { write(l: string): void },
    ) => {
      writer.write(headers.join(" | "));
      for (const row of rows) writer.write(row.join(" | "));
    },
  ),
}));

import {
  routerStats,
  routerPreview,
  routerPolicyGet,
  routerPolicySet,
} from "../router.js";
import { apiGetOrThrow, apiPostOrThrow } from "../../lib/api.js";

function memoryWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => {
        out.push(line);
      },
      writeErr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

const STATS = {
  rows: [
    {
      taskClass: "auth/single",
      model: "anthropic/claude-sonnet-5",
      tier: "balanced",
      samples: 40,
      verifiedCount: 39,
      verifiedRate: 0.975,
      avgCostUsdMicros: 4200,
      avgLatencyMs: 3100,
      lastSeen: "2026-07-10",
    },
  ],
  summary: [
    {
      taskClass: "auth/single",
      cheapestEligibleModel: "anthropic/claude-sonnet-5",
      verifiedRate: 0.975,
      avgCostUsdMicros: 4200,
      candidateCount: 2,
      eligibleCount: 1,
    },
  ],
  window: { windowDays: 30, minSamples: 20, successThreshold: 0.95 },
};

const savedExit = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  process.exitCode = savedExit;
});

describe("router stats", () => {
  it("--json emits the exact payload on stdout", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce(STATS);
    const { writer, out } = memoryWriter();
    await routerStats({ json: true }, writer);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual(STATS);
  });

  it("passes snake_case query params to the stats route", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce(STATS);
    const { writer } = memoryWriter();
    await routerStats(
      { taskClass: "auth/single", window: 7, minSamples: 5 },
      writer,
    );
    expect(apiGetOrThrow).toHaveBeenCalledWith("router/stats", {
      task_class: "auth/single",
      window_days: 7,
      min_samples: 5,
    });
  });

  it("pretty mode renders the rows and the cheapest-per-class summary", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce(STATS);
    const { writer, out } = memoryWriter();
    await routerStats({}, writer);
    const text = out.join("\n");
    expect(text).toContain("claude-sonnet-5");
    expect(text).toContain("97.5%");
    expect(text).toContain("Cheapest model clearing the bar");
  });

  it("empty rows show the accrual hint", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce({
      ...STATS,
      rows: [],
      summary: [],
    });
    const { writer, out } = memoryWriter();
    await routerStats({}, writer);
    expect(out.join("\n")).toContain("No routing outcomes recorded yet");
  });
});

describe("router preview", () => {
  const DECISION = {
    tier: "fast",
    model: "anthropic/claude-haiku-4.5",
    rationale: "market route — cheapest model clearing 95% verified",
    source: "market",
    taskClass: "design/single",
    candidates: [
      {
        model: "anthropic/claude-haiku-4.5",
        verifiedRate: 0.96,
        samples: 100,
        avgCostUsdMicros: 500,
        eligible: true,
        reason: "clears bar",
      },
    ],
    policySnapshot: {
      mode: "enforce",
      successThreshold: 0.95,
      minSamples: 20,
      windowDays: 30,
      escalateOnRejection: true,
    },
  };

  it("posts the prompt + signals and renders the decision", async () => {
    (apiPostOrThrow as unknown as Mock).mockResolvedValueOnce(DECISION);
    const { writer, out } = memoryWriter();
    await routerPreview(
      "refactor the widget",
      { files: 2, crossPackage: true },
      writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith("router/preview", {
      prompt: "refactor the widget",
      fileCount: 2,
      crossPackage: true,
      taskClass: undefined,
    });
    const text = out.join("\n");
    expect(text).toContain("design/single");
    expect(text).toContain("claude-haiku-4.5");
    expect(text).toContain("market");
  });
});

describe("router policy get/set", () => {
  const POLICY = {
    mode: "shadow",
    successThreshold: 0.95,
    minSamples: 20,
    windowDays: 30,
    escalateOnRejection: true,
    source: "workspace",
  };

  it("get renders the effective policy + provenance", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce(POLICY);
    const { writer, out } = memoryWriter();
    await routerPolicyGet({}, writer);
    const text = out.join("\n");
    expect(text).toContain("shadow");
    expect(text).toContain("source");
    expect(text).toContain("workspace");
  });

  it("set posts the changed fields and renders the result", async () => {
    (apiPostOrThrow as unknown as Mock).mockResolvedValueOnce({
      scope: "workspace",
      mode: "enforce",
      successThreshold: 0.9,
      minSamples: 10,
      windowDays: 30,
      escalateOnRejection: true,
    });
    const { writer, out } = memoryWriter();
    await routerPolicySet(
      { mode: "enforce", threshold: 0.9, minSamples: 10 },
      writer,
    );
    expect(apiPostOrThrow).toHaveBeenCalledWith("router/policy/set", {
      scope: undefined,
      mode: "enforce",
      successThreshold: 0.9,
      minSamples: 10,
      windowDays: undefined,
      escalateOnRejection: undefined,
    });
    expect(out.join("\n")).toContain("enforce");
  });

  it("routes an API failure to stderr", async () => {
    (apiGetOrThrow as unknown as Mock).mockRejectedValueOnce(new Error("boom"));
    const { writer, out, err } = memoryWriter();
    await routerPolicyGet({}, writer);
    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain("boom");
  });
});
