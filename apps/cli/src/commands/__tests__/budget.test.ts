/**
 * `oxagen budget …` output-discipline tests. Mocks the shared API client so no
 * network is needed; asserts --json emits the exact contract payload, pretty
 * mode renders the table/alerts, the rolling/monthly windowDays cross-field
 * rule fails fast client-side (no API call), and API failures route to
 * stderr.
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

vi.mock("../../lib/api.js", () => ({
  apiGetOrThrow: vi.fn(),
  apiPutOrThrow: vi.fn(),
  printTable: vi.fn(
    (
      headers: string[],
      rows: string[][],
      writer: { write(l: string): void },
    ) => {
      writer.write(headers.join(" | "));
      for (const row of rows) writer.write(row.join(" | "));
    },
  ),
}));

import { budgetShow, budgetSet, type SpendBudgetStatus } from "../budget.js";
import { apiGetOrThrow, apiPutOrThrow } from "../../lib/api.js";

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

const NORMAL_BUDGET: SpendBudgetStatus = {
  scope: "workspace",
  publicId: "budg_1",
  enabled: true,
  period: "monthly",
  windowDays: null,
  limitUsd: 500,
  spentUsd: 120.5,
  projectedUsd: 250,
  ratio: 0.241,
  state: "ok",
  reachedThreshold: 0,
  windowStart: "2026-07-01T00:00:00.000Z",
  windowEnd: "2026-07-21T00:00:00.000Z",
};

const EXCEEDED_BUDGET: SpendBudgetStatus = {
  scope: "org",
  publicId: "budg_2",
  enabled: true,
  period: "rolling",
  windowDays: 7,
  limitUsd: 500,
  spentUsd: 612.34,
  projectedUsd: 612.34,
  ratio: 1.2247,
  state: "exceeded",
  reachedThreshold: 100,
  windowStart: "2026-07-14T00:00:00.000Z",
  windowEnd: "2026-07-21T00:00:00.000Z",
};

const NO_BUDGET_CONFIGURED: SpendBudgetStatus = {
  scope: "workspace",
  publicId: null,
  enabled: false,
  period: "monthly",
  windowDays: null,
  limitUsd: null,
  spentUsd: 42.1,
  projectedUsd: 84.2,
  ratio: 0,
  state: "ok",
  reachedThreshold: 0,
  windowStart: "2026-07-01T00:00:00.000Z",
  windowEnd: "2026-07-21T00:00:00.000Z",
};

const savedExit = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  process.exitCode = savedExit;
});

describe("budget show", () => {
  it("--json emits the exact payload on stdout", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce({
      budgets: [NORMAL_BUDGET],
    });
    const { writer, out } = memoryWriter();
    await budgetShow({ json: true }, writer);
    expect(apiGetOrThrow).toHaveBeenCalledWith("billing/budget");
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({ budgets: [NORMAL_BUDGET] });
  });

  it("pretty mode renders a normal (ok) budget's scope, limit, spent, projected, and percent", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce({
      budgets: [NORMAL_BUDGET],
    });
    const { writer, out } = memoryWriter();
    await budgetShow({}, writer);
    const text = out.join("\n");
    expect(text).toContain("workspace");
    expect(text).toContain("$500.00");
    expect(text).toContain("$120.50");
    expect(text).toContain("$250.00");
    expect(text).toContain("24%");
    expect(text).toContain("ok");
    // A healthy budget must not trigger the alert section.
    expect(text).not.toContain("⚠");
  });

  it("pretty mode flags an exceeded budget with an alert line", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce({
      budgets: [EXCEEDED_BUDGET],
    });
    const { writer, out } = memoryWriter();
    await budgetShow({}, writer);
    const text = out.join("\n");
    expect(text).toContain("EXCEEDED");
    expect(text).toContain("rolling (7d)");
    expect(text).toContain("⚠ org budget has been exceeded");
    expect(text).toContain("$612.34");
  });

  it("renders the no-ceiling-configured row without a bogus percentage", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce({
      budgets: [NO_BUDGET_CONFIGURED],
    });
    const { writer, out } = memoryWriter();
    await budgetShow({}, writer);
    const text = out.join("\n");
    expect(text).toContain("—"); // limit + percent both render as em dash
    expect(text).toContain("$42.10");
    expect(text).not.toContain("⚠");
  });

  it("empty budgets array shows the setup hint", async () => {
    (apiGetOrThrow as unknown as Mock).mockResolvedValueOnce({ budgets: [] });
    const { writer, out } = memoryWriter();
    await budgetShow({}, writer);
    expect(out.join("\n")).toContain("No spend ceilings configured");
    expect(out.join("\n")).toContain("oxagen budget set");
  });

  it("routes an API failure to stderr", async () => {
    (apiGetOrThrow as unknown as Mock).mockRejectedValueOnce(new Error("boom"));
    const { writer, out, err } = memoryWriter();
    await budgetShow({}, writer);
    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain("boom");
  });
});

describe("budget set — validation", () => {
  it("rejects an invalid --scope without calling the API", async () => {
    const { writer, err } = memoryWriter();
    await budgetSet({ scope: "nope", period: "monthly", limit: "100" }, writer);
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain('Invalid --scope "nope"');
    expect(apiPutOrThrow).not.toHaveBeenCalled();
  });

  it("rejects an invalid --period without calling the API", async () => {
    const { writer, err } = memoryWriter();
    await budgetSet({ scope: "org", period: "yearly", limit: "100" }, writer);
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain('Invalid --period "yearly"');
    expect(apiPutOrThrow).not.toHaveBeenCalled();
  });

  it("rejects a non-positive --limit without calling the API", async () => {
    const { writer, err } = memoryWriter();
    await budgetSet({ scope: "org", period: "monthly", limit: "0" }, writer);
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain("Invalid --limit");
    expect(apiPutOrThrow).not.toHaveBeenCalled();
  });

  it("rolling without --window-days fails client-side (the contract's refine, mirrored)", async () => {
    const { writer, err } = memoryWriter();
    await budgetSet({ scope: "org", period: "rolling", limit: "100" }, writer);
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain("--window-days is required");
    expect(apiPutOrThrow).not.toHaveBeenCalled();
  });

  it("rolling with a non-positive --window-days fails client-side", async () => {
    const { writer, err } = memoryWriter();
    await budgetSet(
      { scope: "org", period: "rolling", limit: "100", windowDays: "0" },
      writer,
    );
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain("--window-days is required");
    expect(apiPutOrThrow).not.toHaveBeenCalled();
  });

  it("monthly with --window-days set fails client-side", async () => {
    const { writer, err } = memoryWriter();
    await budgetSet(
      { scope: "org", period: "monthly", limit: "100", windowDays: "30" },
      writer,
    );
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain("must be omitted for --period monthly");
    expect(apiPutOrThrow).not.toHaveBeenCalled();
  });

  it("rejects an invalid --enabled value without calling the API", async () => {
    const { writer, err } = memoryWriter();
    await budgetSet(
      { scope: "org", period: "monthly", limit: "100", enabled: "maybe" },
      writer,
    );
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain('Invalid --enabled "maybe"');
    expect(apiPutOrThrow).not.toHaveBeenCalled();
  });
});

describe("budget set — success", () => {
  it("puts the validated monthly body (defaulting enabled to true) and renders the result", async () => {
    (apiPutOrThrow as unknown as Mock).mockResolvedValueOnce(NORMAL_BUDGET);
    const { writer, out } = memoryWriter();
    await budgetSet(
      { scope: "workspace", period: "monthly", limit: "500" },
      writer,
    );
    expect(apiPutOrThrow).toHaveBeenCalledWith("billing/budget", {
      scope: "workspace",
      enabled: true,
      period: "monthly",
      windowDays: undefined,
      limitUsd: 500,
    });
    const text = out.join("\n");
    expect(text).toContain(
      "✓ workspace spend ceiling set to $500.00 (monthly)",
    );
    expect(text).toContain("workspace");
  });

  it("puts the validated rolling body with windowDays and honors --enabled false", async () => {
    (apiPutOrThrow as unknown as Mock).mockResolvedValueOnce(EXCEEDED_BUDGET);
    const { writer } = memoryWriter();
    await budgetSet(
      {
        scope: "org",
        period: "rolling",
        limit: "500",
        windowDays: "7",
        enabled: "false",
      },
      writer,
    );
    expect(apiPutOrThrow).toHaveBeenCalledWith("billing/budget", {
      scope: "org",
      enabled: false,
      period: "rolling",
      windowDays: 7,
      limitUsd: 500,
    });
  });

  it("--json emits the exact returned payload", async () => {
    (apiPutOrThrow as unknown as Mock).mockResolvedValueOnce(NORMAL_BUDGET);
    const { writer, out } = memoryWriter();
    await budgetSet(
      { scope: "workspace", period: "monthly", limit: "500", json: true },
      writer,
    );
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual(NORMAL_BUDGET);
  });

  it("routes an API failure to stderr", async () => {
    (apiPutOrThrow as unknown as Mock).mockRejectedValueOnce(
      new Error("denied"),
    );
    const { writer, out, err } = memoryWriter();
    await budgetSet({ scope: "org", period: "monthly", limit: "500" }, writer);
    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain("denied");
  });
});
