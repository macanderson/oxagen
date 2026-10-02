/**
 * `oxagen steering restore-block <proposal-id> <path>`: the POST it sends,
 * the commit and status it prints, `--json` as the contract's answer, a bad
 * id or file refused with exit 2 before any request, and an API refusal such
 * as `block_intact` on stderr with exit 1. The two API calls are mocked. The
 * rest of lib/api.js is real, so a refusal is the real ApiError with the body
 * in its message, as the client builds it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SteeringPrRestoreManagedBlockOutput } from "@oxagen/oxagen/contracts/steering.pr.restore_managed_block";
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
import {
  managedBlockFile,
  STEERING_RESTORE_BLOCK_CAPABILITIES,
  steeringRestoreBlock,
} from "../steering-restore-block.js";

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
    `Error ${status} from steering/prs/restore-block: ${JSON.stringify({ error, requestId: "req_1" })} (trace iad1::abc)`,
    status,
  );
}

const RESTORED: SteeringPrRestoreManagedBlockOutput = {
  commit_sha: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
  status: "checks_running",
};

const BLOCK_INTACT = {
  code: "conflict",
  reason: "block_intact",
  message: "The managed block in AGENTS.md already matches main.",
};

beforeEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("oxagen steering restore-block", () => {
  it("names the capability it calls", () => {
    expect(STEERING_RESTORE_BLOCK_CAPABILITIES).toEqual(["restore_managed_block"]);
  });

  it("registers under `oxagen steering` with a proposal id, a path, and --json", () => {
    const steering = buildProgram().commands.find((c) => c.name() === "steering");
    const command = steering?.commands.find((c) => c.name() === "restore-block");
    expect(command, "the restore-block subcommand must be registered").toBeDefined();
    expect(command?.registeredArguments.map((a) => [a.name(), a.variadic, a.required])).toEqual([
      ["proposal-id", false, true],
      ["path", false, true],
    ]);
    expect(command?.options.map((o) => o.long)).toEqual(["--json"]);
  });

  it("POSTs the proposal id and the file's own name, and prints the commit and the status", async () => {
    mocks.apiPostOrThrow.mockResolvedValueOnce(RESTORED);
    const { writer, out, err } = memoryWriter();
    await steeringRestoreBlock(" prp_42 ", "./agents.md", {}, writer);
    expect(mocks.apiPostOrThrow).toHaveBeenCalledWith("steering/prs/restore-block", {
      proposalId: "prp_42",
      path: "AGENTS.md",
    });
    expect(out).toEqual([
      "Restored the managed block in AGENTS.md on the steering PR for prp_42.",
      "Commit: 9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
      "Status: checks running",
    ]);
    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the exact answer with --json", async () => {
    mocks.apiPostOrThrow.mockResolvedValueOnce(RESTORED);
    const { writer, out, err } = memoryWriter();
    await steeringRestoreBlock("prp_42", "CLAUDE.md", { json: true }, writer);
    expect(out).toEqual([JSON.stringify(RESTORED)]);
    expect(err).toEqual([]);
  });

  it("refuses a bad proposal id before any request, exit 2 (negative)", async () => {
    const { writer, out, err } = memoryWriter();
    await steeringRestoreBlock("crf_1", "AGENTS.md", {}, writer);
    expect(mocks.apiPostOrThrow).not.toHaveBeenCalled();
    expect(out).toEqual([]);
    expect(err).toEqual([
      'error: expected a proposal id that starts with prp_, got "crf_1"',
      "usage: oxagen steering restore-block <proposal-id> <AGENTS.md|CLAUDE.md|README.md> [--json]",
    ]);
    expect(process.exitCode).toBe(2);
  });

  it("refuses a file that holds no managed block before any request, exit 2 (negative)", async () => {
    const { writer, err } = memoryWriter();
    await steeringRestoreBlock("prp_42", "docs/AGENTS.md", {}, writer);
    expect(mocks.apiPostOrThrow).not.toHaveBeenCalled();
    expect(err[0]).toBe(
      'error: expected AGENTS.md, CLAUDE.md, or README.md, got "docs/AGENTS.md"',
    );
    expect(process.exitCode).toBe(2);
  });

  it("prints a block_intact refusal on stderr and exits 1 (negative)", async () => {
    mocks.apiPostOrThrow.mockRejectedValueOnce(refusal(409, BLOCK_INTACT));
    const { writer, out, err } = memoryWriter();
    await steeringRestoreBlock("prp_42", "AGENTS.md", {}, writer);
    expect(out).toEqual([]);
    expect(err).toEqual(["✗ The managed block in AGENTS.md already matches main."]);
    expect(process.exitCode).toBe(1);
  });

  it("uses block_intact as the json error code under --json (negative)", async () => {
    mocks.apiPostOrThrow.mockRejectedValueOnce(refusal(409, BLOCK_INTACT));
    const { writer, out, err } = memoryWriter();
    await steeringRestoreBlock("prp_42", "AGENTS.md", { json: true }, writer);
    expect(out).toEqual([]);
    expect(err.map((line) => JSON.parse(line))).toEqual([
      {
        type: "error",
        code: "block_intact",
        message: "The managed block in AGENTS.md already matches main.",
      },
    ]);
    expect(process.exitCode).toBe(1);
  });
});

describe("managedBlockFile", () => {
  it("names each managed-block file whatever its case, with or without ./", () => {
    expect(managedBlockFile("AGENTS.md")).toBe("AGENTS.md");
    expect(managedBlockFile(" claude.md ")).toBe("CLAUDE.md");
    expect(managedBlockFile("./Readme.MD")).toBe("README.md");
  });

  it("names nothing for any other path", () => {
    expect(managedBlockFile("docs/AGENTS.md")).toBeNull();
    expect(managedBlockFile("SKILL.md")).toBeNull();
    expect(managedBlockFile("")).toBeNull();
  });
});
