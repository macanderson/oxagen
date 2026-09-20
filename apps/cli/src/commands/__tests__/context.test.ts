/**
 * `oxagen context propose` output-discipline tests: the flag rules (no wasted
 * round trip), the one call it makes, `--json` as the exact payload, and API
 * failures on stderr.
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

import { contextPropose, type ProposalResult } from "../context.js";
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
      write: (l) => {
        out.push(l);
      },
      writeErr: (l) => {
        err.push(l);
      },
    },
    out,
    err,
  };
}

const FLAGS = {
  lineage: "ctx.a",
  kind: "constraint",
  force: "must",
  scope: "workspace",
  statement: "x",
  rationale: "y",
  effect: "forbid",
};

const PROPOSAL: ProposalResult = {
  proposalId: "prp_9",
  lineageId: "ctx.a",
  status: "proposed",
};

beforeEach(() => {
  process.exitCode = undefined;
});
afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe("oxagen context propose", () => {
  it("records the proposal through propose_record and says where its Context PR is opened", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(PROPOSAL);
    const { writer, out, err } = memoryWriter();
    await contextPropose(FLAGS, writer);
    expect(apiPostOrThrow).toHaveBeenCalledTimes(1);
    expect(apiPostOrThrow).toHaveBeenCalledWith("context/proposals/create", {
      record: {
        lineageId: "ctx.a",
        kind: "constraint",
        force: "must",
        sharingScope: "workspace",
        statement: "x",
        constraintEffect: "forbid",
      },
      rationale: "y",
      source: "oxagen context propose",
    });
    expect(out).toEqual([
      "ctx.a · prp_9 · proposed",
      "open its Context PR from Oxagen → Steering; merge there publishes it",
    ]);
    expect(err).toEqual([]);
  });

  it("--json emits the exact payload as one line", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(PROPOSAL);
    const { writer, out } = memoryWriter();
    await contextPropose({ ...FLAGS, json: true }, writer);
    expect(out).toEqual([JSON.stringify(PROPOSAL)]);
  });

  it("refuses a bad flag set before any call: missing flags, a bad kind, an effect on a rule", async () => {
    const { writer, err } = memoryWriter();
    await contextPropose({ lineage: "ctx.a" }, writer);
    expect(err[0]).toContain(
      "--kind, --force, --scope, --statement, --rationale",
    );
    expect(process.exitCode).toBe(2);
    await contextPropose({ ...FLAGS, kind: "directive" }, writer);
    expect(err.at(-2)).toContain("--kind is one of");
    await contextPropose({ ...FLAGS, kind: "rule" }, writer);
    expect(err.at(-2)).toContain("a constraint takes --effect");
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("routes an API failure to stderr with exit code 1", async () => {
    (apiPostOrThrow as Mock).mockRejectedValueOnce(
      new Error("HTTP 403: no_principal"),
    );
    const { writer, out, err } = memoryWriter();
    await contextPropose(FLAGS, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("no_principal");
    expect(process.exitCode).toBe(1);
  });
});
