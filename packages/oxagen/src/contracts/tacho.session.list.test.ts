import { describe, expect, it } from "vitest";
import { tachoSessionList } from "./tacho.session.list";

describe("tachoSessionList", () => {
  it("defaults to root sessions, fifty at a time", () => {
    const parsed = tachoSessionList.input.parse({});
    expect(parsed).toEqual({ includeChildren: false, limit: 50 });
    expect(
      tachoSessionList.input.parse({
        since: "2026-09-08T10:00:00Z",
        outcome: "crashed",
      }).outcome,
    ).toBe("crashed");
    expect(
      tachoSessionList.input.safeParse({ since: "yesterday" }).success,
    ).toBe(false);
    expect(tachoSessionList.name).toBe("list_tacho_sessions");
  });
});
