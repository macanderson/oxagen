import { describe, expect, it } from "vitest";
import { downstreamOf, findCycle, sinksOf, upstreamOf } from "./graph";

// The v0.2 fix-validate-document-review graph: Validate and Document need Fix,
// and Review needs both.
const diamond = [
  { role: "Fix", needs: [] },
  { role: "Validate", needs: ["Fix"] },
  { role: "Document", needs: ["Fix"] },
  { role: "Review", needs: ["Validate", "Document"] },
];

describe("upstreamOf", () => {
  it("returns every stage a stage waits on, through other stages", () => {
    expect([...upstreamOf(diamond, "Review")].sort()).toEqual(["Document", "Fix", "Validate"]);
    expect([...upstreamOf(diamond, "Validate")]).toEqual(["Fix"]);
    expect(upstreamOf(diamond, "Fix").size).toBe(0);
  });

  it("returns nothing for a role not in the graph and skips needs that name no stage", () => {
    expect(upstreamOf(diamond, "Deploy").size).toBe(0);
    expect([...upstreamOf([{ role: "Test", needs: ["Ghost"] }], "Test")]).toEqual(["Ghost"]);
  });
});

describe("downstreamOf", () => {
  it("returns every stage that waits on a stage", () => {
    expect([...downstreamOf(diamond, "Fix")].sort()).toEqual(["Document", "Review", "Validate"]);
    expect([...downstreamOf(diamond, "Validate")]).toEqual(["Review"]);
    expect(downstreamOf(diamond, "Review").size).toBe(0);
  });
});

describe("sinksOf", () => {
  it("returns the stages no other stage needs, in file order", () => {
    expect(sinksOf(diamond)).toEqual(["Review"]);
    const fork = [
      { role: "Fix", needs: [] },
      { role: "Docs", needs: ["Fix"] },
      { role: "Test", needs: ["Fix"] },
    ];
    expect(sinksOf(fork)).toEqual(["Docs", "Test"]);
  });
});

describe("findCycle", () => {
  it("returns null for a graph with no cycle", () => {
    expect(findCycle(diamond)).toBeNull();
  });

  it("returns the roles on a cycle, in order", () => {
    const loop = [
      { role: "Fix", needs: [] },
      { role: "Test", needs: ["Review"] },
      { role: "Review", needs: ["Test"] },
    ];
    expect(findCycle(loop)).toEqual(["Test", "Review"]);
    expect(findCycle([{ role: "Fix", needs: ["Fix"] }])).toEqual(["Fix"]);
  });

  it("ignores needs that name no stage", () => {
    expect(findCycle([{ role: "Test", needs: ["Ghost"] }])).toBeNull();
  });
});
