import { describe, expect, it } from "vitest";
import { browserScreenshot } from "./browser.screenshot";
import { getCapability } from "../registry";

describe("browser.screenshot capability", () => {
  it("is registered with the browser domain and correct metadata", () => {
    const cap = getCapability("screenshot_page");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("browser");
    expect(cap?.scoped).toBe(true);
    expect(cap?.surfaces).toEqual(
      expect.arrayContaining(["api", "mcp", "agent"]),
    );
  });

  it("applies defaults: fullPage false, timeoutMs 60000", () => {
    const parsed = browserScreenshot.input.parse({ sessionId: "sbx_abc" });
    expect(parsed.fullPage).toBe(false);
    expect(parsed.timeoutMs).toBe(60_000);
  });

  it("rejects when sessionId is missing", () => {
    expect(() => browserScreenshot.input.parse({})).toThrow();
  });

  it("rejects an empty sessionId", () => {
    expect(() => browserScreenshot.input.parse({ sessionId: "" })).toThrow();
  });

  it("accepts an optional selector and omitting it is fine", () => {
    const withSelector = browserScreenshot.input.parse({
      sessionId: "sbx_abc",
      selector: ".hero",
    });
    expect(withSelector.selector).toBe(".hero");

    const withoutSelector = browserScreenshot.input.parse({
      sessionId: "sbx_abc",
    });
    expect(withoutSelector.selector).toBeUndefined();
  });

  it("rejects an empty selector string", () => {
    expect(() =>
      browserScreenshot.input.parse({ sessionId: "sbx_abc", selector: "" }),
    ).toThrow();
  });

  it("validates a valid output shape", () => {
    const out = browserScreenshot.output.parse({
      key: "ws/sbx_abc/screenshot_001.png",
      url: "https://blob.example.com/screenshot_001.png",
      width: 1280,
      height: 720,
      bytes: 98304,
    });
    expect(out.key).toBe("ws/sbx_abc/screenshot_001.png");
    expect(out.width).toBe(1280);
    expect(out.height).toBe(720);
    expect(out.bytes).toBe(98304);
  });
});
