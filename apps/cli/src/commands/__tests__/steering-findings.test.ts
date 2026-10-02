/**
 * `oxagen steering findings`: the GET it sends, `--json` as the contract's
 * answer, the table grouped by repository, and an API refusal on stderr with
 * exit 1. Also the refusal reader that promote and restore-block share. The
 * two API calls are mocked. The rest of lib/api.js is real, so a refusal is
 * the real ApiError with the body in its message, as the client builds it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeRepositoryFindingsListOutput } from "@oxagen/oxagen/contracts/repository.findings.list";
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
  apiRefusal,
  STEERING_FINDINGS_CAPABILITIES,
  steeringFindings,
} from "../steering-findings.js";

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
function refusal(path: string, status: number, error: Record<string, string>): ApiError {
  return new ApiError(
    `Error ${status} from ${path}: ${JSON.stringify({ error, requestId: "req_1" })} (trace iad1::abc)`,
    status,
  );
}

const ANSWER: CodeRepositoryFindingsListOutput = {
  repositories: [
    {
      repository_id: "rpb_billing",
      provider: "github",
      full_name: "acme/billing",
      findings: [
        {
          id: "crf_1",
          path: "AGENTS.md",
          line: 12,
          statement: "Force push is fine on feature branches.",
          kind: "contradiction",
          record: {
            lineage: "no-force-push",
            label: "No force push",
            path: "steering/constraints/no-force-push.md",
          },
          pull_request: {
            number: 42,
            url: "https://github.com/acme/billing/pull/42",
            state: "open",
            head_sha: "abc123",
          },
          file_url: "https://github.com/acme/billing/blob/abc123/AGENTS.md#L12",
          checked_at: "2026-10-02T12:00:00.000Z",
          proposal: null,
        },
        {
          id: "crf_2",
          path: "CLAUDE.md",
          line: 3,
          statement: "Run the tests before you push.",
          kind: "repeat",
          record: { lineage: "tests-before-push", label: null, path: null },
          pull_request: {
            number: 40,
            url: "https://github.com/acme/billing/pull/40",
            state: "merged",
            head_sha: "def456",
          },
          file_url: "https://github.com/acme/billing/blob/def456/CLAUDE.md#L3",
          checked_at: "2026-10-01T12:00:00.000Z",
          proposal: { id: "prp_7", status: "checks_running" },
        },
      ],
    },
    {
      repository_id: "rpb_web",
      provider: "gitlab",
      full_name: "acme/web",
      findings: [],
    },
  ],
};

beforeEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("oxagen steering findings", () => {
  it("names the capability it calls", () => {
    expect(STEERING_FINDINGS_CAPABILITIES).toEqual(["list_code_repository_findings"]);
  });

  it("registers under `oxagen steering` with --json and no argument", () => {
    const steering = buildProgram().commands.find((c) => c.name() === "steering");
    const command = steering?.commands.find((c) => c.name() === "findings");
    expect(command, "the findings subcommand must be registered").toBeDefined();
    expect(command?.registeredArguments).toEqual([]);
    expect(command?.options.map((o) => o.long)).toEqual(["--json"]);
  });

  it("GETs repository/findings and prints the exact answer with --json", async () => {
    mocks.apiGetOrThrow.mockResolvedValueOnce(ANSWER);
    const { writer, out, err } = memoryWriter();
    await steeringFindings({ json: true }, writer);
    expect(mocks.apiGetOrThrow).toHaveBeenCalledWith("repository/findings");
    expect(mocks.apiPostOrThrow).not.toHaveBeenCalled();
    expect(out).toEqual([JSON.stringify(ANSWER)]);
    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("prints one row per finding, grouped by repository, and leaves out a repository with none", async () => {
    mocks.apiGetOrThrow.mockResolvedValueOnce(ANSWER);
    const { writer, out, err } = memoryWriter();
    await steeringFindings({}, writer);
    expect(out[0]).toBe("acme/billing (github)");
    expect(out[1]).toMatch(/^FINDING\s+KIND\s+FILE\s+RECORD\s+PULL REQUEST\s+PROPOSAL/);
    expect(out[2]).toMatch(
      /^crf_1\s+contradiction\s+AGENTS\.md:12\s+No force push\s+#42 open\s+none/,
    );
    // A record with no label is named by its lineage.
    expect(out[3]).toMatch(
      /^crf_2\s+repeat\s+CLAUDE\.md:3\s+tests-before-push\s+#40 merged\s+prp_7 \(checks running\)/,
    );
    expect(out.slice(4)).toEqual([
      "",
      "2 findings in 1 repository.",
      "Promote a contradiction to a proposal with `oxagen steering promote <finding-id>`.",
    ]);
    expect(out.join("\n")).not.toContain("acme/web");
    expect(err).toEqual([]);
  });

  it("offers no promote step when every contradiction already has a proposal", async () => {
    const [billing] = ANSWER.repositories;
    mocks.apiGetOrThrow.mockResolvedValueOnce({
      repositories: [
        {
          ...billing,
          findings: billing!.findings.map((f) => ({
            ...f,
            proposal: { id: "prp_9", status: "pr_open" as const },
          })),
        },
      ],
    });
    const { writer, out } = memoryWriter();
    await steeringFindings({}, writer);
    expect(out.at(-1)).toBe("2 findings in 1 repository.");
  });

  it("says so when no repository has a finding", async () => {
    mocks.apiGetOrThrow.mockResolvedValueOnce({ repositories: [ANSWER.repositories[1]] });
    const { writer, out } = memoryWriter();
    await steeringFindings({}, writer);
    expect(out).toEqual([
      "No findings. The Oxagen check found no statement in a linked repository's instruction files that repeats or contradicts a steering record.",
    ]);
  });

  it("prints a refusal's own message on stderr and exits 1 (negative)", async () => {
    mocks.apiGetOrThrow.mockRejectedValueOnce(
      refusal("repository/findings", 403, {
        code: "forbidden",
        message: "Your role cannot read this workspace's findings.",
      }),
    );
    const { writer, out, err } = memoryWriter();
    await steeringFindings({}, writer);
    expect(out).toEqual([]);
    expect(err).toEqual(["✗ Your role cannot read this workspace's findings."]);
    expect(process.exitCode).toBe(1);
  });

  it("prints a json error line with the refusal's code under --json (negative)", async () => {
    mocks.apiGetOrThrow.mockRejectedValueOnce(
      refusal("repository/findings", 403, { code: "forbidden", message: "Denied." }),
    );
    const { writer, err } = memoryWriter();
    await steeringFindings({ json: true }, writer);
    expect(err.map((line) => JSON.parse(line))).toEqual([
      { type: "error", code: "forbidden", message: "Denied." },
    ]);
    expect(process.exitCode).toBe(1);
  });
});

describe("apiRefusal", () => {
  it("reads the code, the reason, and the message from the body in the error's message", () => {
    expect(
      apiRefusal(
        refusal("context/prs/restore-block", 409, {
          code: "conflict",
          reason: "block_intact",
          message: "The block matches main.",
        }),
      ),
    ).toEqual({ code: "conflict", reason: "block_intact", message: "The block matches main." });
  });

  it("keeps the whole message when the failure carries no JSON body", () => {
    const err = new ApiError("Network error calling repository/findings: fetch failed");
    expect(apiRefusal(err)).toEqual({
      code: null,
      reason: null,
      message: "Network error calling repository/findings: fetch failed",
    });
  });

  it("keeps the whole message when the body is not JSON or names no message", () => {
    const notJson = new ApiError("Error 502 from repository/findings: {upstream down}", 502);
    expect(apiRefusal(notJson).message).toBe(notJson.message);
    const noMessage = new ApiError('Error 500 from repository/findings: {"error":{"code":"x"}}', 500);
    expect(apiRefusal(noMessage)).toEqual({ code: null, reason: null, message: noMessage.message });
  });
});
