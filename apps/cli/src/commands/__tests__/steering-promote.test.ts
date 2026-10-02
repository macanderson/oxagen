/**
 * `oxagen steering promote <finding-id>`: the POST it sends, the proposal and
 * steering PR it prints, `--json` as the contract's answer, a bad id refused
 * with exit 2 before any request, and an API refusal on stderr with exit 1.
 * The two API calls are mocked. The rest of lib/api.js is real, so a refusal
 * is the real ApiError with the body in its message, as the client builds it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstructionPromoteOutput } from "@oxagen/oxagen/contracts/repository.instruction.promote";
import type { CommandWriter } from "../../lib/capture-writer.js";

const mocks = vi.hoisted(() => ({
  apiGetOrThrow: vi.fn(),
  apiPostOrThrow: vi.fn(),
}));

vi.mock("../../lib/api.js", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/api.js")>()),
  apiGetOrThrow: mocks.apiGetOrThrow,
  apiPostOrThrow: mocks.apiPostOrThrow,
}));

import { ApiError } from "../../lib/api.js";
import { buildProgram } from "../../program.js";
import { STEERING_PROMOTE_CAPABILITIES, steeringPromote } from "../steering-promote.js";

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

/** An API refusal, worded as lib/api.js words a non-2xx answer. */
function refusal(status: number, error: Record<string, string>): ApiError {
  return new ApiError(
    `Error ${status} from repository/findings/promote: ${JSON.stringify({ error, requestId: "req_1" })}`,
    status,
  );
}

const OPENED: InstructionPromoteOutput = {
  proposal_id: "prp_42",
  lineage: "no-force-push",
  status: "checks_running",
  pull_request: { number: 7, url: "https://github.com/acme/control/pull/7" },
};

beforeEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("oxagen steering promote", () => {
  it("names the capability it calls", () => {
    expect(STEERING_PROMOTE_CAPABILITIES).toEqual(["promote_instruction_to_steering"]);
  });

  it("registers under `oxagen steering` with one required finding id and --json", () => {
    const steering = buildProgram().commands.find((c) => c.name() === "steering");
    const command = steering?.commands.find((c) => c.name() === "promote");
    expect(command, "the promote subcommand must be registered").toBeDefined();
    expect(command?.registeredArguments.map((a) => [a.name(), a.variadic, a.required])).toEqual([
      ["finding-id", false, true],
    ]);
    expect(command?.options.map((o) => o.long)).toEqual(["--json"]);
  });

  it("POSTs the trimmed finding id and prints the proposal, the steering PR, and the status", async () => {
    mocks.apiPostOrThrow.mockResolvedValueOnce(OPENED);
    const { writer, out, err } = memoryWriter();
    await steeringPromote("  crf_1 ", {}, writer);
    expect(mocks.apiPostOrThrow).toHaveBeenCalledWith("repository/findings/promote", {
      finding_id: "crf_1",
    });
    expect(out).toEqual([
      "Opened proposal prp_42 for record no-force-push.",
      "Steering PR: #7 https://github.com/acme/control/pull/7",
      "Status: checks running",
      "Nothing steers until a person merges the steering PR.",
    ]);
    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("says when no steering PR opened", async () => {
    mocks.apiPostOrThrow.mockResolvedValueOnce({
      ...OPENED,
      status: "proposed",
      pull_request: null,
    });
    const { writer, out } = memoryWriter();
    await steeringPromote("crf_1", {}, writer);
    expect(out.slice(1, 3)).toEqual([
      "Steering PR: none yet",
      "Status: waiting for its steering PR",
    ]);
  });

  it("prints the exact answer with --json", async () => {
    mocks.apiPostOrThrow.mockResolvedValueOnce(OPENED);
    const { writer, out, err } = memoryWriter();
    await steeringPromote("crf_1", { json: true }, writer);
    expect(out).toEqual([JSON.stringify(OPENED)]);
    expect(err).toEqual([]);
  });

  it("refuses an id that is not a finding id before any request, exit 2 (negative)", async () => {
    const { writer, out, err } = memoryWriter();
    await steeringPromote("prp_42", {}, writer);
    expect(mocks.apiPostOrThrow).not.toHaveBeenCalled();
    expect(out).toEqual([]);
    expect(err).toEqual([
      'error: expected a finding id that starts with crf_, got "prp_42". Run `oxagen steering findings` to list them.',
      "usage: oxagen steering promote <finding-id> [--json]",
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("prints a refusal and the next step on stderr, and exits 1 (negative)", async () => {
    mocks.apiPostOrThrow.mockRejectedValueOnce(
      refusal(409, {
        code: "conflict",
        reason: "lineage_pr_open",
        message: "https://github.com/acme/control/pull/5 is already open for no-force-push.",
      }),
    );
    const { writer, out, err } = memoryWriter();
    await steeringPromote("crf_1", {}, writer);
    expect(out).toEqual([]);
    expect(err).toEqual([
      "✗ https://github.com/acme/control/pull/5 is already open for no-force-push.",
      "Merge or close the PR that is open on the record, then promote the finding again.",
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("prints a refusal with no next step as one line", async () => {
    mocks.apiPostOrThrow.mockRejectedValueOnce(
      refusal(409, {
        code: "conflict",
        reason: "already_in_steering",
        message: "The statement repeats no-force-push, so steering already says it.",
      }),
    );
    const { writer, err } = memoryWriter();
    await steeringPromote("crf_2", {}, writer);
    expect(err).toEqual(["✗ The statement repeats no-force-push, so steering already says it."]);
    expect(process.exitCode).toBe(1);
  });

  it("uses the refusal's reason as the json error code, with no next-step line (negative)", async () => {
    mocks.apiPostOrThrow.mockRejectedValueOnce(
      refusal(409, {
        code: "conflict",
        reason: "finding_resolved",
        message: "The statement matches no record now.",
      }),
    );
    const { writer, out, err } = memoryWriter();
    await steeringPromote("crf_1", { json: true }, writer);
    expect(out).toEqual([]);
    expect(err.map((line) => JSON.parse(line))).toEqual([
      { type: "error", code: "finding_resolved", message: "The statement matches no record now." },
    ]);
    expect(process.exitCode).toBe(1);
  });
});
