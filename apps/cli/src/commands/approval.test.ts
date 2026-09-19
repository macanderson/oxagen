/**
 * `oxagen approvals resolved` output-discipline tests (#3153). Mocks the
 * shared API client so no network is needed; asserts the POST body, the
 * table rendering (approver column, cursor hint), the empty-range message,
 * and `--json` emitting the exact contract payload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandWriter } from "../lib/capture-writer.js";

const apiMock = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return {
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
    ApiError,
  };
});
vi.mock("../lib/api.js", () => apiMock);

import { approvalsResolved } from "./approval.js";

function memoryWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: { write: (l) => out.push(l), writeErr: (l) => err.push(l) },
    out,
    err,
  };
}

const RESOLVED = {
  items: [
    {
      id: "apr_0123456789abcdefghjkmn",
      runId: null,
      tool: "stripe__create_payment",
      requester: null,
      createdAt: "2026-09-18T10:00:00.000Z",
      expiresAt: "2026-09-18T10:05:00.000Z",
      resolvedAt: "2026-09-18T10:00:01.000Z",
      resolution: "approved" as const,
      resolvedBy: "policy:small-vendor-payments",
      autoRuleId: "small-vendor-payments",
      autoEligibility: null,
      mandateId: null,
      chain: { agentKey: null, rule: null },
    },
  ],
  nextCursor: null,
};

const savedExit = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  process.exitCode = savedExit;
});

describe("approvalsResolved", () => {
  it("POSTs the run/since/until/limit/cursor filters", async () => {
    apiMock.apiPostOrThrow.mockResolvedValue(RESOLVED);
    const { writer } = memoryWriter();
    await approvalsResolved(
      { run: "arun_x", since: "2026-09-01T00:00:00.000Z", limit: 10 },
      writer,
    );
    expect(apiMock.apiPostOrThrow).toHaveBeenCalledWith(
      "agent/approvals/resolved",
      {
        runId: "arun_x",
        since: "2026-09-01T00:00:00.000Z",
        until: undefined,
        limit: 10,
        cursor: undefined,
      },
    );
  });

  it("renders a table with the policy approver, and no more-results hint on the last page", async () => {
    apiMock.apiPostOrThrow.mockResolvedValue(RESOLVED);
    const { writer, out } = memoryWriter();
    await approvalsResolved({}, writer);
    expect(out.join("\n")).toContain("stripe__create_payment");
    expect(out.join("\n")).toContain("policy:small-vendor-payments");
    expect(out.join("\n")).not.toContain("More results");
  });

  it("names the next cursor when a page remains", async () => {
    apiMock.apiPostOrThrow.mockResolvedValue({ ...RESOLVED, nextCursor: "c2" });
    const { writer, out } = memoryWriter();
    await approvalsResolved({}, writer);
    expect(out.join("\n")).toContain("--cursor c2");
  });

  it("says nothing resolved rather than drawing an empty table (negative)", async () => {
    apiMock.apiPostOrThrow.mockResolvedValue({ items: [], nextCursor: null });
    const { writer, out } = memoryWriter();
    await approvalsResolved({}, writer);
    expect(out).toEqual(["No resolved approvals in this range."]);
  });

  it("--json emits the raw contract payload", async () => {
    apiMock.apiPostOrThrow.mockResolvedValue(RESOLVED);
    const { writer, out } = memoryWriter();
    await approvalsResolved({ json: true }, writer);
    expect(JSON.parse(out.join(""))).toEqual(RESOLVED);
  });

  it("routes an API failure to stderr (negative)", async () => {
    apiMock.apiPostOrThrow.mockRejectedValue(new apiMock.ApiError("down", 503));
    const { writer, err } = memoryWriter();
    await approvalsResolved({}, writer);
    expect(err.join("\n")).toContain("down");
  });
});
