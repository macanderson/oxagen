import { describe, expect, it } from "vitest";
import { browserSubmit } from "./browser.submit";
import { getCapability } from "../registry";

describe("browser.submit capability", () => {
  it("is registered with the browser domain and correct metadata", () => {
    const cap = getCapability("submit_page");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("browser");
    expect(cap?.scoped).toBe(true);
    expect(cap?.surfaces).toEqual(
      expect.arrayContaining(["api", "mcp", "agent"]),
    );
  });

  it("applies a default timeoutMs of 60000", () => {
    const parsed = browserSubmit.input.parse({ sessionId: "sbx_abc" });
    expect(parsed.timeoutMs).toBe(60_000);
  });

  it("rejects when sessionId is missing", () => {
    expect(() => browserSubmit.input.parse({})).toThrow();
  });

  it("rejects an empty sessionId", () => {
    expect(() => browserSubmit.input.parse({ sessionId: "" })).toThrow();
  });

  it("accepts an optional selector", () => {
    const withSelector = browserSubmit.input.parse({
      sessionId: "sbx_abc",
      selector: "button[type=submit]",
    });
    expect(withSelector.selector).toBe("button[type=submit]");

    const withoutSelector = browserSubmit.input.parse({ sessionId: "sbx_abc" });
    expect(withoutSelector.selector).toBeUndefined();
  });

  it("rejects an empty selector string", () => {
    expect(() =>
      browserSubmit.input.parse({ sessionId: "sbx_abc", selector: "" }),
    ).toThrow();
  });

  it("validates a valid output shape", () => {
    const out = browserSubmit.output.parse({
      ok: true,
      url: "https://example.com/dashboard",
    });
    expect(out.ok).toBe(true);
    expect(out.url).toBe("https://example.com/dashboard");
  });
});
