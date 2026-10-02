/**
 * `oxagen context propose` and `oxagen context revert` output-discipline
 * tests: the flag rules (no wasted round trip), the one call each makes,
 * `--json` as the exact payload, and API failures on stderr.
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

import {
  contextPropose,
  contextRevert,
  type ProposalResult,
  type RevertResult,
} from "../context.js";
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
  it("records the proposal through propose_record and says where its steering PR is opened", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(PROPOSAL);
    const { writer, out, err } = memoryWriter();
    await contextPropose(FLAGS, writer);
    expect(apiPostOrThrow).toHaveBeenCalledTimes(1);
    expect(apiPostOrThrow).toHaveBeenCalledWith("steering/proposals/create", {
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
      "open its steering PR from Oxagen → Steering; merge there publishes it",
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

const REVERT: RevertResult = {
  proposalId: "prp_9",
  reverted: { number: 519, mergedCommit: "7d2e91a0" },
  pullRequest: {
    number: 520,
    url: "https://github.com/a-intel/platform/pull/520",
    branch: "steering/revert-519",
    headSha: "head9",
  },
  check: "success",
};

describe("oxagen context revert", () => {
  it("opens the revert through revert_steering_pr and names the PR, its link, and the check", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(REVERT);
    const { writer, out, err } = memoryWriter();
    await contextRevert("prp_9", {}, writer);
    expect(apiPostOrThrow).toHaveBeenCalledTimes(1);
    expect(apiPostOrThrow).toHaveBeenCalledWith("steering/prs/revert", {
      proposalId: "prp_9",
    });
    expect(out).toEqual([
      "opened #520 on steering/revert-519: it reverts #519",
      "https://github.com/a-intel/platform/pull/520",
      "Oxagen steering check passed",
    ]);
    expect(err).toEqual([]);
  });

  it("says when no check was reported, as in a legacy repository", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce({ ...REVERT, check: null });
    const { writer, out } = memoryWriter();
    await contextRevert("prp_9", {}, writer);
    expect(out.at(-1)).toBe("no Oxagen steering check was reported");
  });

  it("--json emits the exact payload as one line", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(REVERT);
    const { writer, out } = memoryWriter();
    await contextRevert("prp_9", { json: true }, writer);
    expect(out).toEqual([JSON.stringify(REVERT)]);
  });

  it("refuses an argument that is not a proposal id before any call", async () => {
    const { writer, err } = memoryWriter();
    await contextRevert("519", {}, writer);
    expect(err[0]).toContain("name the merged proposal");
    expect(process.exitCode).toBe(2);
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("routes a refusal to stderr with exit code 1", async () => {
    (apiPostOrThrow as Mock).mockRejectedValueOnce(
      new Error("HTTP 409: not_merged"),
    );
    const { writer, out, err } = memoryWriter();
    await contextRevert("prp_9", {}, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("not_merged");
    expect(process.exitCode).toBe(1);
  });
});
