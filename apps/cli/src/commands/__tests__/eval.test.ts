/**
 * `oxagen eval …` output-discipline tests (ADR-023 §4) for the representative
 * handler shapes: a list (legacy bare-array --json + table/empty-hint pretty),
 * a create (result envelope + one-line pretty), and a status read (envelope +
 * multi-line pretty). Asserts stdout purity in json mode, chrome/error routing
 * to stderr, preserved legacy payload shapes, and exit-code side effects.
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
  evalDatasetList,
  evalDatasetCreate,
  evalRunStatus,
  evalRunsList,
  evalRunsSeries,
} from "../eval.js";
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

const savedExit = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  process.exitCode = savedExit;
});

const dataset = {
  datasetId: "ds_1",
  name: "regressions",
  slug: "regressions",
  source: "manual",
  itemCount: 12,
};

describe("eval datasets list", () => {
  it("--json emits the LEGACY bare array shape, one line, stdout only", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue({ datasets: [dataset] });
    const { writer, out, err } = memoryWriter();
    await evalDatasetList({ json: true }, writer);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toEqual([dataset]);
    expect(err).toEqual([]);
  });

  it("pretty renders a table; empty list renders the hint", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue({ datasets: [dataset] });
    const { writer, out } = memoryWriter();
    await evalDatasetList({}, writer);
    expect(out.join("\n")).toContain("regressions");

    (apiGetOrThrow as Mock).mockResolvedValue({ datasets: [] });
    const empty = memoryWriter();
    await evalDatasetList({}, empty.writer);
    expect(empty.out.join("\n")).toContain("No eval datasets yet");
  });

  it("API failure is a uniform stderr error with exit 1 and clean stdout", async () => {
    (apiGetOrThrow as Mock).mockRejectedValue(new Error("401 unauthorized"));
    const { writer, out, err } = memoryWriter();
    process.exitCode = 0;
    await evalDatasetList({ json: true }, writer);
    expect(out).toEqual([]);
    expect(JSON.parse(err[0] as string)).toMatchObject({
      type: "error",
      code: "api",
    });
    expect(process.exitCode).toBe(1);
  });
});

describe("eval dataset-create", () => {
  it("posts the payload and emits the result envelope / pretty line", async () => {
    (apiPostOrThrow as Mock).mockResolvedValue({
      datasetId: "d",
      publicId: "pub_1",
      slug: "s",
    });
    const { writer, out } = memoryWriter();
    await evalDatasetCreate("My Set", { slug: "s", json: true }, writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("eval/datasets", {
      name: "My Set",
      slug: "s",
      description: undefined,
    });
    expect(JSON.parse(out[0] as string)).toEqual({
      datasetId: "d",
      publicId: "pub_1",
      slug: "s",
    });

    const pretty = memoryWriter();
    await evalDatasetCreate("My Set", {}, pretty.writer);
    expect(pretty.out.join(" ")).toContain('Created eval dataset "My Set"');
  });
});

describe("eval run-status", () => {
  const status = {
    runId: "run_9",
    status: "running",
    itemCount: 10,
    completedCount: 4,
    failedCount: 1,
    avgScore: 0.8125,
    failureReason: null,
  };

  it("--json emits the envelope verbatim", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue(status);
    const { writer, out, err } = memoryWriter();
    await evalRunStatus("run_9", { json: true }, writer);
    expect(JSON.parse(out[0] as string)).toEqual(status);
    expect(err).toEqual([]);
    expect(apiGetOrThrow).toHaveBeenCalledWith("eval/runs/status", {
      runPublicId: "run_9",
    });
  });

  it("pretty renders progress lines including the formatted score", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue(status);
    const { writer, out } = memoryWriter();
    await evalRunStatus("run_9", {}, writer);
    const text = out.join("\n");
    expect(text).toContain("Run run_9: running");
    expect(text).toContain("4/10 completed, 1 failed");
    expect(text).toContain("0.813");
  });

  it("API failure routes to the uniform error path", async () => {
    (apiGetOrThrow as Mock).mockRejectedValue(new Error("boom"));
    const { writer, err } = memoryWriter();
    await evalRunStatus("run_9", {}, writer);
    expect(err.join(" ")).toContain("boom");
    expect(process.exitCode).toBe(1);
  });
});

describe("eval runs-list", () => {
  const listResult = {
    runs: [
      {
        runId: "evr_1",
        datasetId: "evd_1",
        datasetName: "Support QA",
        datasetSlug: "support-qa",
        name: "Nightly",
        target: {
          kind: "model",
          model: "anthropic/claude-opus-4.8",
          agentSlug: null,
        },
        judgeModel: "openai/gpt-5",
        status: "completed",
        itemCount: 10,
        completedCount: 10,
        failedCount: 0,
        avgScore: 0.912,
        passThreshold: 0.7,
        costUsdMicros: 500000,
        inputTokens: 1000,
        outputTokens: 400,
        createdAt: "2026-07-01T00:00:00.000Z",
        completedAt: "2026-07-01T00:05:00.000Z",
      },
    ],
    total: 1,
    allTimeTotal: 3,
  };

  it("passes filters/sort/pagination through and --json emits the envelope", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue(listResult);
    const { writer, out, err } = memoryWriter();
    await evalRunsList(
      {
        dataset: "evd_1",
        status: "completed",
        sort: "score",
        dir: "desc",
        limit: 25,
        offset: 0,
        json: true,
      },
      writer,
    );
    expect(JSON.parse(out[0] as string)).toEqual(listResult);
    expect(err).toEqual([]);
    expect(apiGetOrThrow).toHaveBeenCalledWith("eval/runs/list", {
      datasetPublicId: "evd_1",
      since: undefined,
      until: undefined,
      status: "completed",
      model: undefined,
      sortBy: "score",
      sortDir: "desc",
      limit: 25,
      offset: 0,
    });
  });

  it("pretty renders a table with the score and the showing/all-time footer", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue(listResult);
    const { writer, out } = memoryWriter();
    await evalRunsList({}, writer);
    const text = out.join("\n");
    expect(text).toContain("evr_1");
    expect(text).toContain("0.912");
    expect(text).toContain("showing 1 of 1 (all-time 3)");
  });

  it("renders an empty-filter hint with the footer", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue({
      runs: [],
      total: 0,
      allTimeTotal: 5,
    });
    const { writer, out } = memoryWriter();
    await evalRunsList({}, writer);
    const text = out.join("\n");
    expect(text).toContain("No eval runs match this filter.");
    expect(text).toContain("showing 0 of 0 (all-time 5)");
  });

  it("API failure routes to the uniform error path", async () => {
    (apiGetOrThrow as Mock).mockRejectedValue(new Error("nope"));
    const { writer, err } = memoryWriter();
    await evalRunsList({}, writer);
    expect(err.join(" ")).toContain("nope");
    expect(process.exitCode).toBe(1);
  });
});

describe("eval runs-series", () => {
  const seriesResult = {
    overall: [
      { bucketStart: "2026-07-01T00:00:00.000Z", avgScore: 0.9, runCount: 2 },
    ],
    byModel: [
      {
        model: "anthropic/claude-opus-4.8",
        vendor: "anthropic",
        avgScore: 0.9,
        passRate: 1,
        runCount: 2,
        points: [{ bucketStart: "2026-07-01T00:00:00.000Z", avgScore: 0.9 }],
      },
    ],
  };

  it("passes range/bucket through and --json emits the envelope", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue(seriesResult);
    const { writer, out } = memoryWriter();
    await evalRunsSeries(
      { dataset: "evd_1", bucket: "week", json: true },
      writer,
    );
    expect(JSON.parse(out[0] as string)).toEqual(seriesResult);
    expect(apiGetOrThrow).toHaveBeenCalledWith("eval/runs/series", {
      datasetPublicId: "evd_1",
      since: undefined,
      until: undefined,
      bucket: "week",
    });
  });

  it("pretty renders the overall and by-model sections", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue(seriesResult);
    const { writer, out } = memoryWriter();
    await evalRunsSeries({}, writer);
    const text = out.join("\n");
    expect(text).toContain("Overall score over time:");
    expect(text).toContain("By model:");
    expect(text).toContain("anthropic/claude-opus-4.8");
    expect(text).toContain("100.0%");
  });

  it("renders the no-data hint when both series are empty", async () => {
    (apiGetOrThrow as Mock).mockResolvedValue({ overall: [], byModel: [] });
    const { writer, out } = memoryWriter();
    await evalRunsSeries({}, writer);
    expect(out.join("\n")).toContain("(no completed runs in range)");
  });

  it("API failure routes to the uniform error path", async () => {
    (apiGetOrThrow as Mock).mockRejectedValue(new Error("kaboom"));
    const { writer, err } = memoryWriter();
    await evalRunsSeries({}, writer);
    expect(err.join(" ")).toContain("kaboom");
    expect(process.exitCode).toBe(1);
  });
});
