/**
 * `oxagen run answer` (`answer_interjection`, #3941): each answer form posts
 * its body to agent/interjections/answer, `--json` emits the contract
 * payload, pretty mode prints the receipt, what a link or create bound, and
 * the command, and a wrong set of flags or an API failure goes to stderr
 * before or instead of any request. The API client is mocked; no network is
 * needed.
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

import { runAnswer, runAnswerBody, type RunAnswerResult } from "../run.js";
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
const ID = "inj_0123456789abcdefghjkmn";

const TEXT: RunAnswerResult = {
  interjectionId: ID,
  runId: "tse_0123456789abcdefghjkmn",
  answeredAt: "2026-09-25T09:10:00.000Z",
  commandIds: ["tcm_1"],
  receiptId: "rcp_0123456789abcdefghjkmn",
  path: null,
  repository: null,
  workspace: null,
};

const LINKED: RunAnswerResult = {
  ...TEXT,
  path: "link",
  repository: { bindingId: "rpb_0123456789abcdef012345", fullName: "acme/api" },
};

const CREATED: RunAnswerResult = {
  ...TEXT,
  path: "create",
  repository: { bindingId: "rpb_fedcba9876543210fedcba", fullName: "acme/api" },
  workspace: { publicId: "ws_0123456789abcdefghjkmn", slug: "api" },
};

describe("oxagen run answer", () => {
  beforeEach(() => {
    post.mockReset();
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("posts a trimmed free-text answer and emits the receipt as JSON", async () => {
    post.mockResolvedValue(TEXT);
    const { writer, out, err } = memoryWriter();
    await runAnswer(ID, { text: "  Cut it from main.  ", json: true }, writer);
    expect(post).toHaveBeenCalledWith("agent/interjections/answer", {
      interjectionId: ID,
      answer: "Cut it from main.",
    });
    expect(out).toEqual([JSON.stringify(TEXT)]);
    expect(err).toEqual([]);
  });

  it("links the repository and prints the receipt, the binding and the command", async () => {
    post.mockResolvedValue(LINKED);
    const { writer, out } = memoryWriter();
    await runAnswer(ID, { link: true }, writer);
    expect(post).toHaveBeenCalledWith("agent/interjections/answer", {
      interjectionId: ID,
      path: "link",
    });
    expect(out).toEqual([
      `Answered ${ID} on tse_0123456789abcdefghjkmn. Receipt rcp_0123456789abcdefghjkmn.`,
      "Linked acme/api to this workspace (binding rpb_0123456789abcdef012345).",
      "The run's host collects the answer with command tcm_1.",
    ]);
  });

  it("creates a workspace for the repository and prints what it made", async () => {
    post.mockResolvedValue({ ...CREATED, commandIds: [] });
    const { writer, out } = memoryWriter();
    await runAnswer(ID, { create: "API", slug: "api" }, writer);
    expect(post).toHaveBeenCalledWith("agent/interjections/answer", {
      interjectionId: ID,
      path: "create",
      create: { name: "API", slug: "api" },
    });
    expect(out).toEqual([
      `Answered ${ID} on tse_0123456789abcdefghjkmn. Receipt rcp_0123456789abcdefghjkmn.`,
      "Created the workspace api (ws_0123456789abcdefghjkmn) for acme/api. Its skills are off.",
      "No host can take the answer now, so it is recorded on the question only.",
    ]);
  });

  it("refuses no answer, two answers, --slug alone, and --create without --slug, before any request (negative)", async () => {
    for (const opts of [
      {},
      { text: "yes", link: true },
      { link: true, create: "API", slug: "api" },
      { text: "yes", slug: "api" },
      { create: "API" },
      { text: "   " },
    ]) {
      const { writer, out, err } = memoryWriter();
      process.exitCode = undefined;
      await runAnswer(ID, opts, writer);
      expect(out, JSON.stringify(opts)).toEqual([]);
      expect(err.join("\n"), JSON.stringify(opts)).toContain(
        "Nothing was answered",
      );
      expect(process.exitCode).toBe(1);
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("puts an API refusal on stderr and exits 1 (negative)", async () => {
    post.mockRejectedValue(new Error("org_role_required"));
    const { writer, out, err } = memoryWriter();
    await runAnswer(ID, { link: true }, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("org_role_required");
    expect(process.exitCode).toBe(1);
  });
});

describe("runAnswerBody", () => {
  it("builds exactly one answer form", () => {
    expect(runAnswerBody(ID, { text: "yes" })).toEqual({
      body: { interjectionId: ID, answer: "yes" },
    });
    expect(runAnswerBody(ID, { link: true })).toEqual({
      body: { interjectionId: ID, path: "link" },
    });
    expect(runAnswerBody(ID, { create: " API ", slug: "api" })).toEqual({
      body: {
        interjectionId: ID,
        path: "create",
        create: { name: "API", slug: "api" },
      },
    });
  });
});
