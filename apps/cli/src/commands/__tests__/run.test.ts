/**
 * `oxagen run export` output discipline: --json emits the exact contract
 * payload, pretty mode prints the export id, and an API failure goes to
 * stderr. The shared API client is mocked; no network is needed.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", () => ({ apiPostOrThrow: vi.fn() }));

import { runExport } from "../run.js";
import { apiPostOrThrow } from "../../lib/api.js";

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

const post = apiPostOrThrow as Mock;

describe("oxagen run export", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("posts the run id to runs/export and emits the queued export as JSON", async () => {
    post.mockResolvedValue({ exportId: "rexp_0123", status: "queued" });
    const { writer, out, err } = memoryWriter();
    await runExport("tse_0a1b2c", { json: true }, writer);
    expect(post).toHaveBeenCalledWith("runs/export", { runId: "tse_0a1b2c" });
    expect(out).toEqual(['{"exportId":"rexp_0123","status":"queued"}']);
    expect(err).toEqual([]);
  });

  it("prints the export id and where the bundle will be listed in pretty mode", async () => {
    post.mockResolvedValue({ exportId: "rexp_0123", status: "queued" });
    const { writer, out } = memoryWriter();
    await runExport("arun_5f0c", {}, writer);
    expect(out[0]).toBe("Export rexp_0123 queued for arun_5f0c.");
    expect(out[1]).toMatch(/Audit › exports/);
  });

  it("routes an API failure to stderr and writes nothing to stdout (negative)", async () => {
    post.mockRejectedValue(new Error("409 conflict: run_not_sealed"));
    const { writer, out, err } = memoryWriter();
    await runExport("tse_live", {}, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/run_not_sealed/);
  });
});
