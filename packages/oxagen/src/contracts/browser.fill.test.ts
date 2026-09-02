import { describe, expect, it } from "vitest";
import { browserFill } from "./browser.fill";
import { getCapability } from "../registry";

describe("browser.fill capability", () => {
  it("is registered with the browser domain and correct metadata", () => {
    const cap = getCapability("fill_page");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("browser");
    expect(cap?.scoped).toBe(true);
    expect(cap?.surfaces).toEqual(
      expect.arrayContaining(["api", "mcp", "agent"]),
    );
  });

  it("applies a default timeoutMs of 30000", () => {
    const parsed = browserFill.input.parse({
      sessionId: "sbx_abc",
      selector: "#email",
      value: "user@example.com",
    });
    expect(parsed.timeoutMs).toBe(30_000);
  });

  it("rejects when sessionId is missing", () => {
    expect(() =>
      browserFill.input.parse({ selector: "#email", value: "x" }),
    ).toThrow();
  });

  it("rejects when selector is missing", () => {
    expect(() =>
      browserFill.input.parse({ sessionId: "sbx_abc", value: "x" }),
    ).toThrow();
  });

  it("rejects an empty selector", () => {
    expect(() =>
      browserFill.input.parse({
        sessionId: "sbx_abc",
        selector: "",
        value: "x",
      }),
    ).toThrow();
  });

  it("accepts an empty value (clears the field)", () => {
    const parsed = browserFill.input.parse({
      sessionId: "sbx_abc",
      selector: "#email",
      value: "",
    });
    expect(parsed.value).toBe("");
  });

  it("rejects timeoutMs below the minimum", () => {
    expect(() =>
      browserFill.input.parse({
        sessionId: "sbx_abc",
        selector: "#email",
        value: "x",
        timeoutMs: 0,
      }),
    ).toThrow();
  });

  it("validates a valid output shape", () => {
    const out = browserFill.output.parse({ ok: true });
    expect(out.ok).toBe(true);
  });
});
