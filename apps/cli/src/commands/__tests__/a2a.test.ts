/**
 * `oxagen a2a card` output-discipline tests.
 *
 * Asserts the ADR-023 §4 contract: --json emits exactly one single-line JSON
 * value on stdout (shape preserved); pretty mode renders the human card on
 * stdout; and every failure path is a uniform stderr error line (pretty: `✗ …`,
 * json: `{"type":"error",…}`) with exit code 1 and nothing on stdout.
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

vi.mock("../../lib/config.js", () => ({
  getApiUrl: vi.fn(() => "https://api.test"),
  getOrgId: vi.fn(() => "org1"),
  getWorkspaceId: vi.fn(() => "ws1"),
  getToken: vi.fn(() => "tok1"),
}));

import { handleA2ACard } from "../a2a.js";
import { getOrgId, getWorkspaceId, getToken } from "../../lib/config.js";

function makeWriter(): { writer: CommandWriter; out: string[]; err: string[] } {
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

const CARD = {
  name: "Test Workspace",
  description: "A test A2A agent card",
  url: "https://api.test/v1/org1/ws1/a2a",
  protocolVersion: "1.0",
  skills: [
    { id: "s1", name: "Ask", description: "answer questions" },
    { id: "s2", name: "Solve", description: "fix bugs" },
  ],
};

let prevExit: typeof process.exitCode;
let fetchMock: Mock;

beforeEach(() => {
  prevExit = process.exitCode;
  process.exitCode = 0;
  vi.mocked(getOrgId).mockReturnValue("org1");
  vi.mocked(getWorkspaceId).mockReturnValue("ws1");
  vi.mocked(getToken).mockReturnValue("tok1");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  process.exitCode = prevExit;
  vi.unstubAllGlobals();
});

describe("handleA2ACard", () => {
  it("emits one single-line JSON value on stdout in --json mode", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => CARD,
    } as unknown as Response);
    const { writer, out, err } = makeWriter();
    await handleA2ACard({ json: true }, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(JSON.stringify(CARD)); // single line, no indentation
    expect(out[0]).not.toContain("\n");
    expect(JSON.parse(out[0] as string)).toEqual(CARD); // shape preserved
    expect(err).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it("renders the human card on stdout without --json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => CARD,
    } as unknown as Response);
    const { writer, out, err } = makeWriter();
    await handleA2ACard({}, writer);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Test Workspace");
    expect(out[0]).toContain("A2A protocol: 1.0");
    expect(out[0]).toContain("Skills (2):");
    expect(out[0]).toContain("• Ask (s1) — answer questions");
    expect(err).toEqual([]);
  });

  it("errors to stderr with exit 1 (and no fetch) when org/workspace is missing", async () => {
    vi.mocked(getOrgId).mockReturnValue(undefined as unknown as string);
    const { writer, out, err } = makeWriter();
    await handleA2ACard({}, writer);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^✗ /);
    expect(err[0]).toContain("Missing org or workspace");
    expect(process.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits a json error object on stderr in --json mode", async () => {
    vi.mocked(getToken).mockReturnValue(undefined as unknown as string);
    const { writer, out, err } = makeWriter();
    await handleA2ACard({ json: true }, writer);
    expect(out).toEqual([]);
    expect(JSON.parse(err[0] as string)).toEqual({
      type: "error",
      code: "auth",
      message: expect.stringContaining("Not authenticated"),
    });
    expect(process.exitCode).toBe(1);
  });

  it("errors on a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { writer, out, err } = makeWriter();
    await handleA2ACard({}, writer);
    expect(out).toEqual([]);
    expect(err[0]).toContain("Failed to reach the API: ECONNREFUSED");
    expect(process.exitCode).toBe(1);
  });

  it("errors on a non-2xx response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "unavailable",
    } as unknown as Response);
    const { writer, out, err } = makeWriter();
    await handleA2ACard({}, writer);
    expect(out).toEqual([]);
    expect(err[0]).toContain("HTTP 503");
    expect(process.exitCode).toBe(1);
  });
});
