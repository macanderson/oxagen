import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compactSealedAttempts: vi.fn(),
  loggerInfo: vi.fn(),
}));

type StepRun = (name: string, fn: () => unknown) => Promise<unknown>;
type Handler = (ctx: { step: { run: StepRun } }) => Promise<unknown>;

/** Where the createFunction stub leaves the handler the module hands it. */
const captured = vi.hoisted(
  () => ({ handler: undefined }) as { handler?: Handler },
);

vi.mock("../create-function", () => ({
  createFunction: (_opts: unknown, _trigger: unknown, fn: Handler) => {
    captured.handler = fn;
    return [{}, {}];
  },
}));
vi.mock("../logger", () => ({ logger: { info: mocks.loggerInfo } }));
vi.mock("../lib/run-record", () => ({
  ledgerStore: () => ({ compactSealedAttempts: mocks.compactSealedAttempts }),
}));

import "./evidence.frame-compaction";

describe("evidence.frame-compaction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls the compaction with no cutoff: the hot window is the SQL function's constant", async () => {
    mocks.compactSealedAttempts.mockResolvedValue(7);
    const steps: string[] = [];
    const result = await captured.handler?.({
      step: {
        run: async (name, fn) => {
          steps.push(name);
          return fn();
        },
      },
    });
    expect(steps).toEqual(["compact-sealed-attempts"]);
    expect(mocks.compactSealedAttempts).toHaveBeenCalledWith();
    expect(result).toEqual({ removed: 7 });
  });
});
