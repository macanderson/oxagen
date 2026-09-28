/**
 * `oxagen run answer` (`answer_interjection`, #3941): each answer form posts
 * its body to agent/interjections/answer, `--json` emits the contract
 * payload, pretty mode prints the receipt, what a link or create opened or
 * bound, and the command, and a wrong set of flags or an API failure goes to
 * stderr before or instead of any request. The API client is mocked; no network is
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

// A link opens a steering PR and binds nothing until it merges (ADR-212).
const LINKED: RunAnswerResult = {
  ...TEXT,
  path: "link",
  repository: {
    bindingId: null,
    fullName: "acme/api",
    steeringPullRequest: {
      number: 7,
      url: "https://github.com/acme/control/pull/7",
      reused: false,
    },
  },
};

// A create binds no repository since lane S1 (#4450).
const CREATED: RunAnswerResult = {
  ...TEXT,
  path: "create",
  repository: null,
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

  it("prints the receipt, the steering PR that links the repository, and the command", async () => {
    post.mockResolvedValue(LINKED);
    const { writer, out } = memoryWriter();
    await runAnswer(ID, { link: true }, writer);
    expect(post).toHaveBeenCalledWith("agent/interjections/answer", {
      interjectionId: ID,
      path: "link",
    });
    expect(out).toEqual([
      `Answered ${ID} on tse_0123456789abcdefghjkmn. Receipt rcp_0123456789abcdefghjkmn.`,
      "Opened steering PR #7 to link acme/api to this workspace: https://github.com/acme/control/pull/7. Merge the steering PR to finish linking.",
      "The run's host collects the answer with command tcm_1.",
    ]);
  });

  it("names the binding when the repository was linked already", async () => {
    post.mockResolvedValue({
      ...LINKED,
      repository: {
        bindingId: "rpb_0123456789abcdef012345",
        fullName: "acme/api",
        steeringPullRequest: null,
      },
    });
    const { writer, out } = memoryWriter();
    await runAnswer(ID, { link: true }, writer);
    expect(out[1]).toBe(
      "acme/api is linked to this workspace already (binding rpb_0123456789abcdef012345).",
    );
  });

  it("says the next sync links a repository workspace.toml lists already", async () => {
    post.mockResolvedValue({
      ...LINKED,
      repository: {
        bindingId: null,
        fullName: "acme/api",
        steeringPullRequest: null,
      },
    });
    const { writer, out } = memoryWriter();
    await runAnswer(ID, { link: true }, writer);
    expect(out[1]).toBe(
      "workspace.toml already lists acme/api. The next steering sync links it.",
    );
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
      "Created the workspace api (ws_0123456789abcdefghjkmn). Its skills are off, and no repository is linked to it yet.",
      "No host can take the answer now, so it is recorded on the question only.",
    ]);
  });

  it("names the repository a create bound when an older server answers with one", async () => {
    post.mockResolvedValue({
      ...CREATED,
      repository: {
        bindingId: "rpb_fedcba9876543210fedcba",
        fullName: "acme/api",
        steeringPullRequest: null,
      },
      commandIds: [],
    });
    const { writer, out } = memoryWriter();
    await runAnswer(ID, { create: "API", slug: "api" }, writer);
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
