/**
 * Best-effort persistence must stay best-effort (never throw) AND leave a
 * diagnostic breadcrumb under OXAGEN_DEBUG instead of swallowing the failure
 * silently. Previously these catches were empty, so a dropped trace / verbose
 * record was invisible even with debugging on.
 *
 * node:fs is mocked to fail every write so we exercise the catch paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: () => false,
  mkdirSync: () => undefined,
  readFileSync: () => {
    throw new Error("read boom");
  },
  writeFileSync: () => {
    throw new Error("disk full");
  },
  appendFileSync: () => {
    throw new Error("disk full");
  },
}));

const { openTraceStore } = await import("../trace-store.js");
const { appendVerboseLog } = await import("../verbose-log.js");

const trace = { id: "t1", originalPrompt: "p" } as unknown as Parameters<
  typeof appendVerboseLog
>[1];

const spyStderr = () =>
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);

describe("best-effort persistence logging", () => {
  let stderr: ReturnType<typeof spyStderr>;
  let prevDebug: string | undefined;

  beforeEach(() => {
    prevDebug = process.env["OXAGEN_DEBUG"];
    stderr = spyStderr();
  });
  afterEach(() => {
    stderr.mockRestore();
    if (prevDebug === undefined) delete process.env["OXAGEN_DEBUG"];
    else process.env["OXAGEN_DEBUG"] = prevDebug;
  });

  it("trace-store: does not throw and logs under OXAGEN_DEBUG", () => {
    process.env["OXAGEN_DEBUG"] = "1";
    expect(() => openTraceStore("/x").record(trace as never)).not.toThrow();
    expect(
      stderr.mock.calls.some((c) => String(c[0]).includes("[trace-store]")),
    ).toBe(true);
  });

  it("verbose-log: does not throw and logs under OXAGEN_DEBUG", () => {
    process.env["OXAGEN_DEBUG"] = "1";
    expect(() => appendVerboseLog("/x", trace)).not.toThrow();
    expect(
      stderr.mock.calls.some((c) => String(c[0]).includes("[verbose-log]")),
    ).toBe(true);
  });

  it("stays silent when OXAGEN_DEBUG is unset (still no throw)", () => {
    delete process.env["OXAGEN_DEBUG"];
    expect(() => openTraceStore("/x").record(trace as never)).not.toThrow();
    expect(() => appendVerboseLog("/x", trace)).not.toThrow();
    expect(
      stderr.mock.calls.some(
        (c) =>
          String(c[0]).includes("[trace-store]") ||
          String(c[0]).includes("[verbose-log]"),
      ),
    ).toBe(false);
  });
});
