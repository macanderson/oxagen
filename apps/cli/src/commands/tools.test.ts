/**
 * `oxagen tools migrate` output-discipline tests (#4948). Mocks the shared API
 * client so no network is needed. Asserts the POST path and body, the line for
 * each state, `--json` emitting the exact contract payload, and an API failure
 * going to stderr with exit 1.
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
  return { apiPostOrThrow: vi.fn(), ApiError };
});
vi.mock("../lib/api.js", () => apiMock);

import { buildProgram } from "../program.js";
import { toolsMigrate, type ToolMigrationOutput } from "./tools.js";

function memoryWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: { write: (l) => out.push(l), writeErr: (l) => err.push(l) },
    out,
    err,
  };
}

const PR = { number: 12, url: "https://github.com/acme/oxagen-support/pull/12" };
const PR_2 = { number: 13, url: "https://github.com/acme/oxagen-support/pull/13" };

const savedExit = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  process.exitCode = savedExit;
});

describe("oxagen tools migrate", () => {
  it("posts an empty body to the migration route", async () => {
    apiMock.apiPostOrThrow.mockResolvedValue({ state: "opened", pullRequest: PR, pullRequests: [PR] });
    const { writer } = memoryWriter();

    await toolsMigrate({}, writer);

    expect(apiMock.apiPostOrThrow).toHaveBeenCalledWith("tools/steering/migrate", {});
  });

  it("names each pull request the run opened", async () => {
    const output: ToolMigrationOutput = {
      state: "opened",
      pullRequest: PR,
      pullRequests: [PR, PR_2],
    };
    apiMock.apiPostOrThrow.mockResolvedValue(output);
    const { writer, out } = memoryWriter();

    await toolsMigrate({}, writer);

    expect(out[0]).toMatch(/^Opened the migration pull request\./);
    expect(out.slice(1)).toEqual([`#12  ${PR.url}`, `#13  ${PR_2.url}`]);
  });

  it("says the pull request is already open, and names it", async () => {
    apiMock.apiPostOrThrow.mockResolvedValue({
      state: "already_open",
      pullRequest: PR,
      pullRequests: [PR],
    });
    const { writer, out } = memoryWriter();

    await toolsMigrate({}, writer);

    expect(out).toEqual([
      "The migration pull request is already open. Review and merge it to move the servers.",
      `#12  ${PR.url}`,
    ]);
  });

  it("says the workspace has migrated, with no pull request when it never needed one", async () => {
    apiMock.apiPostOrThrow.mockResolvedValue({
      state: "already_migrated",
      pullRequest: null,
      pullRequests: [],
    });
    const { writer, out } = memoryWriter();

    await toolsMigrate({}, writer);

    expect(out).toEqual(["This workspace's MCP servers already live in its steering repo."]);
  });

  it("prints the exact contract payload with --json", async () => {
    const output = { state: "already_open", pullRequest: PR, pullRequests: [PR] };
    apiMock.apiPostOrThrow.mockResolvedValue(output);
    const { writer, out } = memoryWriter();

    await toolsMigrate({ json: true }, writer);

    expect(out).toEqual([JSON.stringify(output)]);
  });

  it("reports an API refusal on stderr and exits 1", async () => {
    apiMock.apiPostOrThrow.mockRejectedValue(
      new apiMock.ApiError("This workspace has no steering repo yet.", 404),
    );
    const { writer, out, err } = memoryWriter();

    await toolsMigrate({}, writer);

    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("This workspace has no steering repo yet.");
    expect(process.exitCode).toBe(1);
  });
});

describe("the tools command group", () => {
  it("registers `tools migrate` with --json", () => {
    const tools = buildProgram().commands.find((c) => c.name() === "tools");
    const migrate = tools?.commands.find((c) => c.name() === "migrate");
    expect(migrate, "tools migrate must be registered").toBeDefined();
    expect(migrate?.options.map((o) => o.long)).toEqual(["--json"]);
  });
});
