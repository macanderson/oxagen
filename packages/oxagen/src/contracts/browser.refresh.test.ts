import { describe, expect, it } from "vitest";
import { browserRefresh } from "./browser.refresh";
import { getCapability } from "../registry";

describe("browser.refresh capability", () => {
  it("is registered with the browser domain and correct metadata", () => {
    const cap = getCapability("refresh_page");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("browser");
    expect(cap?.scoped).toBe(true);
    expect(cap?.surfaces).toEqual(
      expect.arrayContaining(["api", "mcp", "agent"]),
    );
  });

  it("applies a default timeoutMs of 60000", () => {
    const parsed = browserRefresh.input.parse({ sessionId: "sbx_abc" });
    expect(parsed.timeoutMs).toBe(60_000);
  });

  it("rejects when sessionId is missing", () => {
    expect(() => browserRefresh.input.parse({})).toThrow();
  });

  it("rejects an empty sessionId", () => {
    expect(() => browserRefresh.input.parse({ sessionId: "" })).toThrow();
  });

  it("rejects timeoutMs below the minimum", () => {
    expect(() =>
      browserRefresh.input.parse({ sessionId: "sbx_abc", timeoutMs: 999 }),
    ).toThrow();
  });

  it("rejects timeoutMs above the maximum", () => {
    expect(() =>
      browserRefresh.input.parse({ sessionId: "sbx_abc", timeoutMs: 500_000 }),
    ).toThrow();
  });

  it("validates a valid output shape", () => {
    const out = browserRefresh.output.parse({
      ok: true,
      url: "https://example.com/dashboard",
    });
    expect(out.ok).toBe(true);
    expect(out.url).toBe("https://example.com/dashboard");
  });
});
