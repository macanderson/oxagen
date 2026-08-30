import { describe, expect, it } from "vitest";
import { browserRead } from "./browser.read";
import { getCapability } from "../registry";

describe("browser.read capability", () => {
  it("is registered with the browser domain and correct metadata", () => {
    const cap = getCapability("read_page");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("browser");
    expect(cap?.scoped).toBe(true);
    expect(cap?.surfaces).toEqual(
      expect.arrayContaining(["api", "mcp", "agent"]),
    );
  });

  it("applies a default timeoutMs of 30000", () => {
    const parsed = browserRead.input.parse({ sessionId: "sbx_abc" });
    expect(parsed.timeoutMs).toBe(30_000);
  });

  it("rejects when sessionId is missing", () => {
    expect(() => browserRead.input.parse({})).toThrow();
  });

  it("rejects an empty sessionId", () => {
    expect(() => browserRead.input.parse({ sessionId: "" })).toThrow();
  });

  it("accepts an optional selector and omitting it is fine", () => {
    const withSelector = browserRead.input.parse({
      sessionId: "sbx_abc",
      selector: "main",
    });
    expect(withSelector.selector).toBe("main");

    const withoutSelector = browserRead.input.parse({ sessionId: "sbx_abc" });
    expect(withoutSelector.selector).toBeUndefined();
  });

  it("rejects an empty selector string", () => {
    expect(() =>
      browserRead.input.parse({ sessionId: "sbx_abc", selector: "" }),
    ).toThrow();
  });

  it("rejects timeoutMs below the minimum", () => {
    expect(() =>
      browserRead.input.parse({ sessionId: "sbx_abc", timeoutMs: 0 }),
    ).toThrow();
  });

  it("validates a valid output shape", () => {
    const out = browserRead.output.parse({ text: "Welcome to the dashboard" });
    expect(out.text).toBe("Welcome to the dashboard");
  });
});
