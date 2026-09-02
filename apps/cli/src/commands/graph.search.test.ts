/**
 * graph.search.test.ts — pins `oxagen graph search`: the exact `/graph/search`
 * body (query passthrough, CSV label splitting with trim-and-drop-empties,
 * the default limit of 10 vs a parsed `--limit`), and the ADR-023 §4 output
 * discipline through the REAL createOutput — a piped stdout (autoJson) emits
 * one machine line, a TTY without `--json` keeps the 2-space-indented view,
 * and an explicit `--json` wins even on a TTY.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandWriter } from "../lib/capture-writer.js";

const { apiPost } = vi.hoisted(() => ({
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));
vi.mock("../lib/api.js", () => ({ apiPost }));

import { handleGraphSearch } from "./graph.search.js";

function splitWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => void out.push(line),
      writeErr: (line) => void err.push(line),
    },
    out,
    err,
  };
}

const RESULT = { results: [{ id: "n_1", label: "Person", score: 0.91 }] };

/** createOutput reads process.stdout.isTTY directly; pin it per test. */
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
function setStdoutTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

beforeEach(() => {
  apiPost.mockResolvedValue(RESULT);
});

afterEach(() => {
  if (originalIsTTY)
    Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks();
});

describe("handleGraphSearch — request body", () => {
  it("sends the query with no labels and the default limit of 10", async () => {
    setStdoutTTY(false);
    const { writer } = splitWriter();
    await handleGraphSearch({ query: "who bought the pro plan" }, writer);
    expect(apiPost).toHaveBeenCalledWith("graph/search", {
      query: "who bought the pro plan",
      labels: undefined,
      limit: 10,
    });
  });

  it("splits --labels on commas, trims entries, drops empties, and parses --limit", async () => {
    setStdoutTTY(false);
    const { writer } = splitWriter();
    await handleGraphSearch(
      { query: "q", labels: " Person, Company ,,Deal ", limit: "25" },
      writer,
    );
    expect(apiPost).toHaveBeenCalledWith("graph/search", {
      query: "q",
      labels: ["Person", "Company", "Deal"],
      limit: 25,
    });
  });

  it("a --labels of only separators collapses to undefined, not an empty array", async () => {
    setStdoutTTY(false);
    const { writer } = splitWriter();
    await handleGraphSearch({ query: "q", labels: " , ," }, writer);
    expect(apiPost).toHaveBeenCalledWith("graph/search", {
      query: "q",
      labels: undefined,
      limit: 10,
    });
  });
});

describe("handleGraphSearch — output discipline", () => {
  it("a piped stdout (no --json) emits ONE machine line via autoJson", async () => {
    setStdoutTTY(false);
    const { writer, out, err } = splitWriter();
    await handleGraphSearch({ query: "q" }, writer);
    expect(out).toEqual([JSON.stringify(RESULT)]);
    expect(err).toEqual([]);
  });

  it("a TTY without --json keeps the historical 2-space-indented JSON view", async () => {
    setStdoutTTY(true);
    const { writer, out } = splitWriter();
    await handleGraphSearch({ query: "q" }, writer);
    expect(out).toEqual([JSON.stringify(RESULT, null, 2)]);
  });

  it("an explicit --json wins even on a TTY", async () => {
    setStdoutTTY(true);
    const { writer, out } = splitWriter();
    await handleGraphSearch({ query: "q", json: true }, writer);
    expect(out).toEqual([JSON.stringify(RESULT)]);
  });

  it("propagates an apiPost failure instead of swallowing it", async () => {
    setStdoutTTY(false);
    apiPost.mockRejectedValueOnce(new Error("Error 500 from graph/search"));
    const { writer } = splitWriter();
    await expect(handleGraphSearch({ query: "q" }, writer)).rejects.toThrow(
      "Error 500 from graph/search",
    );
  });
});
