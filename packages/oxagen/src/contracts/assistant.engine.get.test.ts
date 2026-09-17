import { describe, expect, it } from "vitest";
import { assistantEngineGet } from "./assistant.engine.get";

describe("get_assistant_engine contract", () => {
  it("is a console read: mutates false, noBillingGate true, scoped", () => {
    expect(assistantEngineGet.mutates).toBe(false);
    expect(assistantEngineGet.noBillingGate).toBe(true);
    expect(assistantEngineGet.scoped).toBe(true);
    expect(assistantEngineGet.input.safeParse({ retry: true }).success).toBe(
      false,
    );
  });

  it("names the observed state, the attempts and a null incident", () => {
    const down = {
      state: "unreachable",
      endpoint: "engine.oxagen.internal:8080",
      attempts: 3,
      error: "ECONNREFUSED",
      checkedAt: "2026-09-14T10:00:00.000Z",
      incident: null,
    };
    expect(assistantEngineGet.output.parse(down)).toEqual(down);
    const ready = { ...down, state: "ready", attempts: 1, error: null };
    expect(assistantEngineGet.output.parse(ready).state).toBe("ready");
    expect(
      assistantEngineGet.output.safeParse({ ...down, state: "down" }).success,
    ).toBe(false);
    expect(
      assistantEngineGet.output.safeParse({ ...down, attempts: 4 }).success,
    ).toBe(false);
  });
});
