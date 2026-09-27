// How the Run page names one frame of a run (#3823): a run's own frame by its
// seq, a subagent's by its chain and seq, the same key the transcript gives
// the frame, and nothing else.
import { describe, expect, it } from "vitest";
import { frameHref, frameKey, parseFrameKey } from "./frame-link";

const CHAIN = "0192d4a8-7c1e-7a00-8000-00000000c1d0";
const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };

describe("frameKey", () => {
  it("names a run's own frame by its seq and a subagent's by its chain and seq", () => {
    expect(frameKey({ seq: "3" })).toBe("3");
    expect(frameKey({ seq: "3", chainRef: null })).toBe("3");
    expect(frameKey({ seq: "3", chainRef: CHAIN })).toBe(`${CHAIN}:3`);
  });
});

describe("parseFrameKey", () => {
  it("reads back every key frameKey writes", () => {
    expect(parseFrameKey("0")).toEqual({ seq: "0" });
    expect(parseFrameKey(`${CHAIN}:0`)).toEqual({ seq: "0", chainRef: CHAIN });
    expect(parseFrameKey(`${CHAIN.toUpperCase()}:12`)).toEqual({
      seq: "12",
      chainRef: CHAIN,
    });
  });

  it("names no frame for anything else (negative)", () => {
    for (const value of [
      null,
      "",
      "../etc",
      "-1",
      "1".repeat(20),
      "agent-1:3",
      `${CHAIN}:`,
      `${CHAIN}:x`,
      ":3",
      `${CHAIN}:3:4`,
    ])
      expect(parseFrameKey(value)).toBeNull();
  });
});

describe("frameHref", () => {
  it("opens the frame on the Governed actions tab, on the chain it was recorded on", () => {
    expect(frameHref(PLACE, { seq: "3" })).toBe(
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=3",
    );
    expect(frameHref(PLACE, { seq: "3", chainRef: CHAIN })).toBe(
      `/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=${CHAIN}%3A3`,
    );
  });
});
