/**
 * `oxagen run pause-all` (`pause_workspace_runs`): it posts the reason to
 * commands/pause-workspace, `--json` emits the contract payload, pretty mode
 * prints the queued count, each skipped run with why, and the command ids,
 * and an empty reason or an API failure goes to stderr. The API client is
 * mocked; no network is needed.
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

vi.mock("../../lib/api.js", () => ({ apiPostOrThrow: vi.fn() }));
vi.mock("../../lib/config.js", () => ({
  getApiUrl: () => "https://api.example.test",
}));

import { runPauseAll, type RunPauseAllResult } from "../run.js";
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

const RECEIPT: RunPauseAllResult = {
  queued: 2,
  commandIds: ["tcm_1", "tcm_2"],
  skipped: [
    {
      runId: "tse_0123456789abcdefghjkmn",
      agentKey: "acme.core.cc-laptop",
      reason: "host_offline",
      commandId: "tcm_3",
    },
  ],
};

describe("oxagen run pause-all", () => {
  beforeEach(() => {
    post.mockReset();
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("posts the trimmed reason to commands/pause-workspace and emits the receipt as JSON", async () => {
    post.mockResolvedValue(RECEIPT);
    const { writer, out, err } = memoryWriter();
    await runPauseAll({ reason: "  Incident 42  ", json: true }, writer);
    expect(post).toHaveBeenCalledWith("commands/pause-workspace", {
      reason: "Incident 42",
    });
    expect(out).toEqual([JSON.stringify(RECEIPT)]);
    expect(err).toEqual([]);
  });

  it("prints the queued count, each skipped run with why, and the command ids", async () => {
    post.mockResolvedValue(RECEIPT);
    const { writer, out } = memoryWriter();
    await runPauseAll({ reason: "Incident 42" }, writer);
    expect(out).toEqual([
      "Queued a pause for 2 live runs.",
      "Skipped 1, which no host can reach:",
      "  tse_0123456789abcdefghjkmn (acme.core.cc-laptop): the run's host has not checked in for five minutes",
      "Command ids: tcm_1, tcm_2",
      "Ledger runs are not paused. Each run stops at its next boundary once its host collects the command.",
    ]);
  });

  it("says so when no live run took the pause", async () => {
    post.mockResolvedValue({ queued: 0, commandIds: [], skipped: [] });
    const { writer, out } = memoryWriter();
    await runPauseAll({ reason: "Incident 42" }, writer);
    expect(out[0]).toBe("Queued a pause for 0 live runs.");
    expect(out.join("\n")).not.toContain("Command ids");
  });

  it("refuses an empty reason before any request (negative)", async () => {
    const { writer, out, err } = memoryWriter();
    await runPauseAll({ reason: "   " }, writer);
    expect(post).not.toHaveBeenCalled();
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("Give a reason with --reason");
    expect(process.exitCode).toBe(1);
  });

  it("puts an API refusal on stderr and exits 1 (negative)", async () => {
    post.mockRejectedValue(new Error("org_role_required"));
    const { writer, out, err } = memoryWriter();
    await runPauseAll({ reason: "Incident 42" }, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("org_role_required");
    expect(process.exitCode).toBe(1);
  });
});
