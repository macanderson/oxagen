/**
 * `oxagen sandbox warm|rename` wiring + `--repo` parsing tests. The commands are
 * thin HTTP wrappers, so we mock `apiPost` and assert the request body (repos
 * array, rename payload) and the --json output discipline.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api.js")>();
  return { ...actual, apiPost: vi.fn() };
});

import {
  parseRepoSpec,
  handleSandboxWarm,
  handleSandboxRename,
} from "../sandbox.js";
import { apiPost } from "../../lib/api.js";

const mockPost = apiPost as unknown as Mock;

function makeWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (l) => void out.push(l),
      writeErr: (l) => void err.push(l),
    },
    out,
    err,
  };
}

beforeEach(() => {
  mockPost.mockReset();
});

describe("parseRepoSpec", () => {
  it("parses owner/name", () => {
    expect(parseRepoSpec("acme/api")).toEqual({ owner: "acme", repo: "api" });
  });

  it("parses owner/name#branch", () => {
    expect(parseRepoSpec("acme/api#dev")).toEqual({
      owner: "acme",
      repo: "api",
      branch: "dev",
    });
  });

  it("rejects a value with no slash", () => {
    expect(() => parseRepoSpec("acme")).toThrow(/expected owner\/name/);
  });

  it("rejects a leading or trailing slash", () => {
    expect(() => parseRepoSpec("/api")).toThrow();
    expect(() => parseRepoSpec("acme/")).toThrow();
  });
});

describe("handleSandboxWarm", () => {
  it("maps repeated --repo flags into the repos array", async () => {
    mockPost.mockResolvedValue({
      sessionId: "sbx_1",
      status: "running",
      image: "agent",
      createdAt: "t",
      reused: false,
    });
    const { writer, out } = makeWriter();

    await handleSandboxWarm(
      { sessionKey: "conv_1", label: "x", repo: ["acme/api#main", "acme/web"] },
      writer,
    );

    expect(mockPost).toHaveBeenCalledWith(
      "agent/sandbox/start",
      {
        sessionKey: "conv_1",
        label: "x",
        repos: [
          { owner: "acme", repo: "api", branch: "main" },
          { owner: "acme", repo: "web" },
        ],
      },
      writer,
    );
    expect(out.join("\n")).toContain("sbx_1");
  });

  it("omits repos entirely when no --repo is passed", async () => {
    mockPost.mockResolvedValue({
      sessionId: "sbx_2",
      status: "running",
      image: "agent",
      createdAt: "t",
      reused: true,
    });
    const { writer } = makeWriter();

    await handleSandboxWarm({}, writer);

    expect(mockPost).toHaveBeenCalledWith("agent/sandbox/start", {}, writer);
  });

  it("emits raw JSON with --json", async () => {
    const res = {
      sessionId: "sbx_3",
      status: "running",
      image: "agent",
      createdAt: "t",
      reused: false,
    };
    mockPost.mockResolvedValue(res);
    const { writer, out } = makeWriter();

    await handleSandboxWarm({ json: true }, writer);

    expect(JSON.parse(out[0]!)).toEqual(res);
  });
});

describe("handleSandboxRename", () => {
  it("POSTs sessionId + label and prints a summary", async () => {
    mockPost.mockResolvedValue({ sessionId: "sbx_1", label: "acme refactor" });
    const { writer, out } = makeWriter();

    await handleSandboxRename("sbx_1", "acme refactor", {}, writer);

    expect(mockPost).toHaveBeenCalledWith(
      "agent/sandbox/rename",
      { sessionId: "sbx_1", label: "acme refactor" },
      writer,
    );
    expect(out.join("\n")).toContain("renamed to");
  });
});
