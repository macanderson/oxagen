import { describe, expect, it } from "vitest";
import { evalRunList } from "./eval.run.list";
import { getCapability } from "../registry";

describe("eval.run.list capability", () => {
  it("applies defaults for sort/dir/limit/offset on a bare input", () => {
    const parsed = evalRunList.input.parse({});
    expect(parsed.sortBy).toBe("created");
    expect(parsed.sortDir).toBe("desc");
    expect(parsed.limit).toBe(25);
    expect(parsed.offset).toBe(0);
    expect(parsed.datasetPublicId).toBeUndefined();
  });

  it("parses explicit filters, sort, and pagination", () => {
    const parsed = evalRunList.input.parse({
      datasetPublicId: "evd_1",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
      status: "completed",
      model: "anthropic/claude-opus-4.8",
      sortBy: "score",
      sortDir: "asc",
      limit: 50,
      offset: 25,
    });
    expect(parsed.status).toBe("completed");
    expect(parsed.sortBy).toBe("score");
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(25);
  });

  it("rejects a limit over the max of 100", () => {
    expect(() => evalRunList.input.parse({ limit: 101 })).toThrow();
  });

  it("rejects a negative offset", () => {
    expect(() => evalRunList.input.parse({ offset: -1 })).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => evalRunList.input.parse({ status: "bogus" })).toThrow();
  });

  it("rejects a non-datetime since", () => {
    expect(() => evalRunList.input.parse({ since: "yesterday" })).toThrow();
  });

  it("parses a valid output", () => {
    const out = evalRunList.output.parse({
      runs: [
        {
          runId: "evr_1",
          datasetId: "evd_1",
          datasetName: "Support QA",
          datasetSlug: "support-qa",
          name: null,
          target: {
            kind: "model",
            model: "anthropic/claude-opus-4.8",
            agentSlug: null,
          },
          judgeModel: "openai/gpt-5",
          status: "completed",
          itemCount: 10,
          completedCount: 10,
          failedCount: 0,
          avgScore: 0.91,
          passThreshold: 0.7,
          costUsdMicros: 12345,
          inputTokens: 1000,
          outputTokens: 500,
          createdAt: "2026-07-01T00:00:00.000Z",
          completedAt: "2026-07-01T00:05:00.000Z",
        },
      ],
      total: 1,
      allTimeTotal: 3,
    });
    expect(out.runs).toHaveLength(1);
    expect(out.allTimeTotal).toBe(3);
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("list_eval_runs")).toBe(evalRunList);
  });
});
