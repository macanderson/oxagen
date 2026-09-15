/**
 * `oxagen context propose` output-discipline tests: the two entry forms, the
 * client-side flag rules (no wasted round trip), `--json` as the exact payload,
 * and API failures on stderr.
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

import { contextPropose, type ContextPrResult } from "../context.js";
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

const PR: ContextPrResult = {
  proposalId: "prp_1",
  lineageId: "ctx.release.no-reread-changelog",
  status: "checks_passed",
  governanceMode: "team",
  pr: {
    number: 519,
    url: "https://github.com/a-intel/platform/pull/519",
    repository: "a-intel/platform",
    branch: "context/ctx.release.no-reread-changelog",
  },
  checks: [
    { name: "schema", status: "passed", summary: "context-record/v0.1 valid" },
    { name: "record_hash", status: "passed", summary: "matches the file" },
  ],
  onMerge: {
    review: "team: …",
    bundleVersion: { current: 41, afterMerge: 42 },
  },
};

beforeEach(() => {
  process.exitCode = undefined;
});
afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe("oxagen context propose", () => {
  it("opens the PR for an existing proposal and prints the PR, the checks and what merge does", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(PR);
    const { writer, out, err } = memoryWriter();
    await contextPropose({ proposalId: "prp_1" }, writer);
    expect(apiPostOrThrow).toHaveBeenCalledWith("context/prs/open", {
      proposalId: "prp_1",
    });
    expect(out[0]).toBe(
      "ctx.release.no-reread-changelog · prp_1 · checks_passed",
    );
    expect(out[1]).toContain("a-intel/platform#519");
    expect(out).toContain("checks: 2 / 2");
    expect(out.at(-1)).toBe(
      "merge from Mission Control publishes it as steering v42",
    );
    expect(err).toEqual([]);
  });

  it("records the proposal first when given the record flags, then opens it", async () => {
    (apiPostOrThrow as Mock)
      .mockResolvedValueOnce({ proposalId: "prp_9" })
      .mockResolvedValueOnce(PR);
    const { writer } = memoryWriter();
    await contextPropose(
      {
        lineage: "ctx.a",
        kind: "constraint",
        force: "must",
        scope: "workspace",
        statement: "x",
        rationale: "y",
        effect: "forbid",
        json: true,
      },
      writer,
    );
    expect(apiPostOrThrow).toHaveBeenNthCalledWith(
      1,
      "context/proposals/create",
      {
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
      },
    );
    expect(apiPostOrThrow).toHaveBeenNthCalledWith(2, "context/prs/open", {
      proposalId: "prp_9",
    });
  });

  it("--json emits the exact payload as one line", async () => {
    (apiPostOrThrow as Mock).mockResolvedValueOnce(PR);
    const { writer, out } = memoryWriter();
    await contextPropose({ proposalId: "prp_1", json: true }, writer);
    expect(out).toEqual([JSON.stringify(PR)]);
  });

  it("refuses a bad flag set before any call: missing flags, a bad kind, an effect on a rule", async () => {
    const { writer, err } = memoryWriter();
    await contextPropose({ lineage: "ctx.a" }, writer);
    expect(err[0]).toContain(
      "--kind, --force, --scope, --statement, --rationale",
    );
    expect(process.exitCode).toBe(2);
    await contextPropose(
      {
        lineage: "ctx.a",
        kind: "directive",
        force: "must",
        scope: "workspace",
        statement: "x",
        rationale: "y",
      },
      writer,
    );
    expect(err.at(-2)).toContain("--kind is one of");
    await contextPropose(
      {
        lineage: "ctx.a",
        kind: "rule",
        force: "must",
        scope: "workspace",
        statement: "x",
        rationale: "y",
        effect: "forbid",
      },
      writer,
    );
    expect(err.at(-2)).toContain("a constraint takes --effect");
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  it("routes an API failure to stderr with exit code 1", async () => {
    (apiPostOrThrow as Mock).mockRejectedValueOnce(
      new Error("HTTP 409: lineage_pr_open"),
    );
    const { writer, out, err } = memoryWriter();
    await contextPropose({ proposalId: "prp_1" }, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("lineage_pr_open");
    expect(process.exitCode).toBe(1);
  });
});
