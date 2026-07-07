/**
 * `oxagen eval …` output-discipline tests (ADR-023 §4) for the representative
 * handler shapes: a list (legacy bare-array --json + table/empty-hint pretty),
 * a create (result envelope + one-line pretty), and a status read (envelope +
 * multi-line pretty). Asserts stdout purity in json mode, chrome/error routing
 * to stderr, preserved legacy payload shapes, and exit-code side effects.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", () => ({
  apiGetOrThrow: vi.fn(),
  apiPostOrThrow: vi.fn(),
  printTable: vi.fn((headers: string[], rows: string[][], writer: { write(l: string): void }) => {
    writer.write(headers.join(" | "));
    for (const row of rows) writer.write(row.join(" | "));
  }),
}));

import { evalDatasetList, evalDatasetCreate, evalRunStatus } from "../eval.js";
import { apiGetOrThrow, apiPostOrThrow } from "../../lib/api.js";

function memoryWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
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
    expect(JSON.parse(err[0] as string)).toMatchObject({ type: "error", code: "api" });
    expect(process.exitCode).toBe(1);
  });
});

describe("eval dataset-create", () => {
  it("posts the payload and emits the result envelope / pretty line", async () => {
    (apiPostOrThrow as Mock).mockResolvedValue({ datasetId: "d", publicId: "pub_1", slug: "s" });
    const { writer, out } = memoryWriter();
    await evalDatasetCreate("My Set", { slug: "s", json: true }, writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("eval/datasets", {
      name: "My Set",
      slug: "s",
      description: undefined,
    });
    expect(JSON.parse(out[0] as string)).toEqual({ datasetId: "d", publicId: "pub_1", slug: "s" });

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
    expect(apiGetOrThrow).toHaveBeenCalledWith("eval/runs/status", { runPublicId: "run_9" });
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
