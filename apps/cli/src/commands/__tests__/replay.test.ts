/**
 * `oxagen replay` handler — proves --list prints the list, a resolved turn prints
 * the full report, and an unresolved turn errors to stderr with a non-zero exit.
 * The trace store and formatter are mocked, so no filesystem is touched.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";

vi.mock("../../agent/trace-store.js", () => ({ openTraceStore: vi.fn() }));
vi.mock("../../agent/trace-format.js", () => ({
  formatTraceText: vi.fn(() => "FULL REPORT"),
  formatTraceList: vi.fn(() => "THE LIST"),
}));

import { handleReplay } from "../replay.js";
import { openTraceStore } from "../../agent/trace-store.js";

const mockOpen = openTraceStore as unknown as Mock;

let out = "";
let err = "";
const restorers: Array<() => void> = [];

function storeWith(over: Record<string, unknown>): void {
  mockOpen.mockReturnValue({
    list: () => [],
    resolve: () => undefined,
    get: () => undefined,
    last: () => undefined,
    record: () => undefined,
    ...over,
  });
}

beforeEach(() => {
  out = "";
  err = "";
  process.exitCode = undefined;
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    s: unknown,
  ) => {
    out += String(s);
    return true;
  }) as never);
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    s: unknown,
  ) => {
    err += String(s);
    return true;
  }) as never);
  restorers.push(
    () => outSpy.mockRestore(),
    () => errSpy.mockRestore(),
  );
});

afterEach(() => {
  for (const r of restorers.splice(0)) r();
  process.exitCode = undefined;
});

describe("handleReplay", () => {
  it("prints the list with --list", async () => {
    storeWith({ list: () => [{ id: "a" }] });
    await handleReplay(undefined, { list: true });
    expect(out).toContain("THE LIST");
  });

  it("prints the full report for a resolved turn", async () => {
    storeWith({
      resolve: (arg: string) => (arg === "2" ? { id: "x" } : undefined),
    });
    await handleReplay("2", {});
    expect(out).toContain("FULL REPORT");
    expect(process.exitCode).toBeUndefined();
  });

  it("errors to stderr with a non-zero exit when the turn is not found", async () => {
    storeWith({ resolve: () => undefined });
    await handleReplay("99", {});
    expect(err).toMatch(/^✗ /); // uniform error discipline
    expect(err).toContain('No turn matches "99"');
    expect(process.exitCode).toBe(1);
  });

  it("reports the empty case when no turns exist", async () => {
    storeWith({ resolve: () => undefined });
    await handleReplay(undefined, {});
    expect(err).toContain("No turns recorded yet");
    expect(process.exitCode).toBe(1);
  });
});
