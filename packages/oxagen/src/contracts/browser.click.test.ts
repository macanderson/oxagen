import { describe, expect, it } from "vitest";
import { browserClick } from "./browser.click";
import { getCapability } from "../registry";

describe("browser.click capability", () => {
  it("is registered with the browser domain and correct metadata", () => {
    const cap = getCapability("click_page");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("browser");
    expect(cap?.scoped).toBe(true);
    expect(cap?.surfaces).toEqual(
      expect.arrayContaining(["api", "mcp", "agent"]),
    );
  });

  it("applies a default timeoutMs of 60000", () => {
    const parsed = browserClick.input.parse({
      sessionId: "sbx_abc",
      selector: "button.primary",
    });
    expect(parsed.timeoutMs).toBe(60_000);
  });

  it("rejects when sessionId is missing", () => {
    expect(() =>
      browserClick.input.parse({ selector: "button.primary" }),
    ).toThrow();
  });

  it("rejects when selector is missing", () => {
    expect(() => browserClick.input.parse({ sessionId: "sbx_abc" })).toThrow();
  });

  it("rejects an empty selector", () => {
    expect(() =>
      browserClick.input.parse({ sessionId: "sbx_abc", selector: "" }),
    ).toThrow();
  });

  it("rejects timeoutMs above the maximum", () => {
    expect(() =>
      browserClick.input.parse({
        sessionId: "sbx_abc",
        selector: "button",
        timeoutMs: 999_999,
      }),
    ).toThrow();
  });

  it("validates a valid output shape", () => {
    const out = browserClick.output.parse({
      ok: true,
      url: "https://example.com/next-page",
    });
    expect(out.ok).toBe(true);
    expect(out.url).toBe("https://example.com/next-page");
  });
});
