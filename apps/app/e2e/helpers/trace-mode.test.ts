import { describe, expect, it } from "vitest";
import { traceMode } from "./trace-mode";

describe("traceMode (#2559)", () => {
  it("defaults to on-first-retry, which is what a pull request should pay for", () => {
    expect(traceMode({})).toBe("on-first-retry");
  });

  it("traces every attempt when a run asks for it", () => {
    // The nightly. `on-first-retry` never records the attempt that failed.
    expect(traceMode({ PLAYWRIGHT_TRACE_ALL: "1" })).toBe("retain-on-failure");
  });

  it("does not read a string 'false' or '0' as opting in", () => {
    // A CI `env:` block writes strings, and "false" arriving as truthy is how
    // a switch ends up permanently on.
    expect(traceMode({ PLAYWRIGHT_TRACE_ALL: "false" })).toBe("on-first-retry");
    expect(traceMode({ PLAYWRIGHT_TRACE_ALL: "0" })).toBe("on-first-retry");
    expect(traceMode({ PLAYWRIGHT_TRACE_ALL: "" })).toBe("on-first-retry");
    expect(traceMode({ PLAYWRIGHT_TRACE_ALL: "  " })).toBe("on-first-retry");
  });

  it("accepts the other spellings a person might write", () => {
    expect(traceMode({ PLAYWRIGHT_TRACE_ALL: "true" })).toBe(
      "retain-on-failure",
    );
    expect(traceMode({ PLAYWRIGHT_TRACE_ALL: "yes" })).toBe(
      "retain-on-failure",
    );
    expect(traceMode({ PLAYWRIGHT_TRACE_ALL: "ON" })).toBe("retain-on-failure");
  });
});
