import { describe, expect, it } from "vitest";
import { webFetch } from "./web.fetch";
import { getCapability } from "../registry";

describe("web.fetch capability", () => {
  // ── input: defaults ───────────────────────────────────────────────────────

  it("defaults extractMarkdown to true", () => {
    const parsed = webFetch.input.parse({ url: "https://example.com" });
    expect(parsed.extractMarkdown).toBe(true);
  });

  it("defaults timeout to 10000", () => {
    const parsed = webFetch.input.parse({ url: "https://example.com" });
    expect(parsed.timeout).toBe(10000);
  });

  // ── input: url validation ─────────────────────────────────────────────────

  it("accepts an https URL", () => {
    const parsed = webFetch.input.parse({ url: "https://example.com/path" });
    expect(parsed.url).toBe("https://example.com/path");
  });

  it("accepts an http URL", () => {
    const parsed = webFetch.input.parse({ url: "http://example.com" });
    expect(parsed.url).toBe("http://example.com");
  });

  it("rejects a non-URL string", () => {
    expect(() => webFetch.input.parse({ url: "not-a-url" })).toThrow();
  });

  it("rejects missing url", () => {
    expect(() => webFetch.input.parse({})).toThrow();
  });

  // ── input: timeout bounds ─────────────────────────────────────────────────

  it("accepts timeout=1000 (min boundary)", () => {
    const parsed = webFetch.input.parse({
      url: "https://example.com",
      timeout: 1000,
    });
    expect(parsed.timeout).toBe(1000);
  });

  it("accepts timeout=30000 (max boundary)", () => {
    const parsed = webFetch.input.parse({
      url: "https://example.com",
      timeout: 30000,
    });
    expect(parsed.timeout).toBe(30000);
  });

  it("rejects timeout=999 (below min)", () => {
    expect(() =>
      webFetch.input.parse({ url: "https://example.com", timeout: 999 }),
    ).toThrow();
  });

  it("rejects timeout=30001 (above max)", () => {
    expect(() =>
      webFetch.input.parse({ url: "https://example.com", timeout: 30001 }),
    ).toThrow();
  });

  it("rejects non-integer timeout", () => {
    expect(() =>
      webFetch.input.parse({ url: "https://example.com", timeout: 5000.5 }),
    ).toThrow();
  });

  // ── input: extractMarkdown ────────────────────────────────────────────────

  it("accepts extractMarkdown=false", () => {
    const parsed = webFetch.input.parse({
      url: "https://example.com",
      extractMarkdown: false,
    });
    expect(parsed.extractMarkdown).toBe(false);
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = webFetch.output.parse({
      url: "https://example.com",
      title: "Example Domain",
      content: "# Example Domain\n\nThis domain is for illustrative examples.",
      wordCount: 9,
      fetchedAt: "2024-06-01T12:00:00.000Z",
      statusCode: 200,
    });
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.title).toBe("Example Domain");
    expect(parsed.wordCount).toBe(9);
    expect(parsed.statusCode).toBe(200);
  });

  it("parses output with wordCount=0", () => {
    const parsed = webFetch.output.parse({
      url: "https://example.com",
      title: "",
      content: "",
      wordCount: 0,
      fetchedAt: "2024-06-01T12:00:00.000Z",
      statusCode: 204,
    });
    expect(parsed.wordCount).toBe(0);
  });

  it("rejects output with negative wordCount", () => {
    expect(() =>
      webFetch.output.parse({
        url: "https://example.com",
        title: "Title",
        content: "Content",
        wordCount: -1,
        fetchedAt: "2024-06-01T12:00:00.000Z",
        statusCode: 200,
      }),
    ).toThrow();
  });

  it("rejects output with invalid url", () => {
    expect(() =>
      webFetch.output.parse({
        url: "not-a-url",
        title: "Title",
        content: "Content",
        wordCount: 5,
        fetchedAt: "2024-06-01T12:00:00.000Z",
        statusCode: 200,
      }),
    ).toThrow();
  });

  it("rejects output missing statusCode", () => {
    expect(() =>
      webFetch.output.parse({
        url: "https://example.com",
        title: "Title",
        content: "Content",
        wordCount: 5,
        fetchedAt: "2024-06-01T12:00:00.000Z",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("fetch_web_page")).toBe(webFetch);
  });
});
