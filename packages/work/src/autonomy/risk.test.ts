import { describe, expect, it } from "vitest";
import { type RiskFile, computeRisk } from "./risk";

const HIGH_PATHS = ["db/migrations/**", "src/auth/**"];

function file(path: string, additions = 1, deletions = 0): RiskFile {
  return { path, additions, deletions };
}

function files(count: number): RiskFile[] {
  return Array.from({ length: count }, (_, i) => file(`src/f${i}.ts`));
}

describe("computeRisk", () => {
  it("is low for a small change that touches no high-risk path and calls no high-risk tool", () => {
    const result = computeRisk({
      files: [file("src/a.ts", 10, 2)],
      highRiskPaths: HIGH_PATHS,
      toolsCalled: [{ name: "fs__read", risk: "low" }],
    });
    expect(result).toEqual({ risk: "low", reasons: [] });
  });

  it("is high when the diff touches a path a policy marks high", () => {
    const result = computeRisk({ files: [file("db/migrations/001.sql")], highRiskPaths: HIGH_PATHS, toolsCalled: [] });
    expect(result).toEqual({
      risk: "high",
      reasons: ["It changes db/migrations/001.sql, which a policy marks high risk (db/migrations/**)."],
    });
  });

  it("is high when a rename moves a file out of a high-risk path", () => {
    const result = computeRisk({
      files: [{ path: "src/login.ts", previousPath: "src/auth/login.ts", additions: 0, deletions: 0 }],
      highRiskPaths: HIGH_PATHS,
      toolsCalled: [],
    });
    expect(result.risk).toBe("high");
    expect(result.reasons).toEqual(["It changes src/auth/login.ts, which a policy marks high risk (src/auth/**)."]);
  });

  it("is high when a session called a high-risk tool, naming each tool once in order", () => {
    const result = computeRisk({
      files: [file("src/a.ts")],
      highRiskPaths: HIGH_PATHS,
      toolsCalled: [
        { name: "prod__drop_table", risk: "high" },
        { name: "fs__write", risk: "medium" },
        { name: "billing__refund", risk: "high" },
        { name: "prod__drop_table", risk: "high" },
      ],
    });
    expect(result).toEqual({
      risk: "high",
      reasons: [
        "A session on it called billing__refund, which MCP Studio classifies as high risk.",
        "A session on it called prod__drop_table, which MCP Studio classifies as high risk.",
      ],
    });
  });

  it("reports only the high-risk reasons when a large change is also high risk", () => {
    const result = computeRisk({
      files: [...files(25), file("src/auth/session.ts", 500, 0)],
      highRiskPaths: HIGH_PATHS,
      toolsCalled: [],
    });
    expect(result.risk).toBe("high");
    expect(result.reasons).toHaveLength(1);
  });

  it("is medium over 400 lines and low at 400", () => {
    const over = computeRisk({ files: [file("src/a.ts", 300, 101)], highRiskPaths: [], toolsCalled: [] });
    expect(over).toEqual({ risk: "medium", reasons: ["It changes 401 lines, more than 400."] });
    const at = computeRisk({ files: [file("src/a.ts", 300, 100)], highRiskPaths: [], toolsCalled: [] });
    expect(at.risk).toBe("low");
  });

  it("is medium over 20 files and low at 20, counting a path once", () => {
    const over = computeRisk({ files: files(21), highRiskPaths: [], toolsCalled: [] });
    expect(over).toEqual({ risk: "medium", reasons: ["It changes 21 files, more than 20."] });
    const at = computeRisk({ files: [...files(20), file("src/f0.ts")], highRiskPaths: [], toolsCalled: [] });
    expect(at.risk).toBe("low");
  });

  it("is medium when a line count cannot be read, and leaves that count out of the total", () => {
    const result = computeRisk({
      files: [
        file("src/a.ts", Number.NaN, 0),
        file("src/b.ts", 1, -1),
        file("src/c.ts", 1.5, 0),
        file("src/d.ts", 399, 0),
      ],
      highRiskPaths: [],
      toolsCalled: [],
    });
    expect(result).toEqual({
      risk: "medium",
      reasons: [
        "Its line count for src/a.ts is not a whole number, so its size is unknown.",
        "Its line count for src/b.ts is not a whole number, so its size is unknown.",
        "Its line count for src/c.ts is not a whole number, so its size is unknown.",
      ],
    });
  });

  it("gives every medium reason that applies", () => {
    const big = files(21).map((f) => ({ ...f, additions: 20 }));
    const result = computeRisk({ files: big, highRiskPaths: [], toolsCalled: [] });
    expect(result.reasons).toEqual(["It changes 420 lines, more than 400.", "It changes 21 files, more than 20."]);
  });
});
