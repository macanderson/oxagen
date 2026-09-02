import { describe, expect, it } from "vitest";
import { browserNavigate } from "./browser.navigate";
import { getCapability } from "../registry";

describe("browser.navigate capability", () => {
  it("is registered with the browser domain and correct metadata", () => {
    const cap = getCapability("navigate_page");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("browser");
    expect(cap?.scoped).toBe(true);
    expect(cap?.surfaces).toEqual(
      expect.arrayContaining(["api", "mcp", "agent"]),
    );
  });

  it("applies a default timeoutMs of 60000", () => {
    const parsed = browserNavigate.input.parse({
      sessionId: "sbx_abc",
      url: "https://example.com",
    });
    expect(parsed.timeoutMs).toBe(60_000);
  });

  it("rejects when sessionId is missing", () => {
    expect(() =>
      browserNavigate.input.parse({ url: "https://example.com" }),
    ).toThrow();
  });

  it("rejects when url is missing", () => {
    expect(() =>
      browserNavigate.input.parse({ sessionId: "sbx_abc" }),
    ).toThrow();
  });

  it("rejects a non-URL string in url", () => {
    expect(() =>
      browserNavigate.input.parse({ sessionId: "sbx_abc", url: "not-a-url" }),
    ).toThrow();
  });

  it("rejects timeoutMs below the minimum", () => {
    expect(() =>
      browserNavigate.input.parse({
        sessionId: "sbx_abc",
        url: "https://example.com",
        timeoutMs: 500,
      }),
    ).toThrow();
  });

  it("rejects timeoutMs above the maximum", () => {
    expect(() =>
      browserNavigate.input.parse({
        sessionId: "sbx_abc",
        url: "https://example.com",
        timeoutMs: 200_000,
      }),
    ).toThrow();
  });

  it("validates a valid output shape", () => {
    const out = browserNavigate.output.parse({
      url: "https://example.com/page",
      title: "Example Page",
    });
    expect(out.url).toBe("https://example.com/page");
    expect(out.title).toBe("Example Page");
  });
});
