import { describe, expect, it } from "vitest";
import { tachoSessionGet } from "./tacho.session.get";

describe("tachoSessionGet", () => {
  it("takes a session uuid and nothing else", () => {
    expect(
      tachoSessionGet.input.parse({
        sessionUuid: "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b",
      }).sessionUuid,
    ).toBeDefined();
    expect(
      tachoSessionGet.input.safeParse({ sessionUuid: "sess-1" }).success,
    ).toBe(false);
    expect(
      tachoSessionGet.input.safeParse({
        sessionUuid: "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b",
        events: true,
      }).success,
    ).toBe(false);
    expect(tachoSessionGet.name).toBe("get_tacho_session");
    expect(tachoSessionGet.mutates).toBe(false);
  });
});
