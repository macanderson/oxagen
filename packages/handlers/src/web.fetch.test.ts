/**
 * Unit tests for the web.fetch handler.
 *
 * Covers:
 *  - Happy path with extractMarkdown=true: returns clean markdown content.
 *  - Happy path with extractMarkdown=false: returns raw HTML.
 *  - Non-http scheme URL: throws scheme-not-allowed error.
 *  - Timeout: throws timeout error when request aborts.
 *  - HTML stripping: verifies <script>, <style>, <nav>, <footer> removed;
 *    <h1>–<h6> converted to markdown; <p> converted to paragraphs.
 *  - Title extraction from <title> tag.
 *  - Word count is populated.
 *  - fetchedAt is a valid ISO 8601 string.
 *  - statusCode is propagated from the HTTP response.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted stubs ─────────────────────────────────────────────────────────────

const { mockWebFetch } = vi.hoisted(() => ({
  mockWebFetch: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@oxagen/web", async (importOriginal) => {
  // Import the real module so extractMarkdownFromHtml is the genuine implementation.
  const real = await importOriginal<typeof import("@oxagen/web")>();
  return {
    ...real,
    // Override only webFetch to control HTTP calls in handler tests.
    webFetch: mockWebFetch,
  };
});

// ── Imports after mocks ───────────────────────────────────────────────────────

import { webFetchHandler } from "./web.fetch";
import { extractMarkdownFromHtml } from "@oxagen/web";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Helpers ───────────────────────────────────────────────────────────────────

const validCtx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api",
  messageId: null,
};

const sampleFetchResult = {
  url: "https://example.com",
  title: "Example Domain",
  content:
    "# Example Domain\n\nThis domain is for use in illustrative examples.",
  wordCount: 13,
  fetchedAt: new Date().toISOString(),
  statusCode: 200,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("webFetchHandler — happy path", () => {
  it("returns result matching the contract output shape", async () => {
    mockWebFetch.mockResolvedValueOnce(sampleFetchResult);

    const result = await webFetchHandler(
      { url: "https://example.com", extractMarkdown: true, timeout: 10000 },
      validCtx,
    );

    expect(result.url).toBe("https://example.com");
    expect(result.title).toBe("Example Domain");
    expect(result.statusCode).toBe(200);
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof result.content).toBe("string");
  });

  it("passes extractMarkdown=false through to webFetch", async () => {
    mockWebFetch.mockResolvedValueOnce({
      ...sampleFetchResult,
      content: "<html><body>Raw HTML</body></html>",
    });

    await webFetchHandler(
      { url: "https://example.com", extractMarkdown: false, timeout: 10000 },
      validCtx,
    );

    const callArg = mockWebFetch.mock.calls[0]![0] as {
      extractMarkdown: boolean;
    };
    expect(callArg.extractMarkdown).toBe(false);
  });

  it("forwards timeout to webFetch", async () => {
    mockWebFetch.mockResolvedValueOnce(sampleFetchResult);

    await webFetchHandler(
      { url: "https://example.com", extractMarkdown: true, timeout: 5000 },
      validCtx,
    );

    const callArg = mockWebFetch.mock.calls[0]![0] as { timeout: number };
    expect(callArg.timeout).toBe(5000);
  });
});

// ── Error propagation ─────────────────────────────────────────────────────────

describe("webFetchHandler — error propagation", () => {
  it("propagates scheme validation errors", async () => {
    mockWebFetch.mockRejectedValueOnce(
      new Error('web.fetch: URL scheme "ftp:" is not allowed'),
    );

    await expect(
      webFetchHandler(
        {
          url: "ftp://example.com/file.txt",
          extractMarkdown: true,
          timeout: 10000,
        },
        validCtx,
      ),
    ).rejects.toThrow(/scheme.*not allowed/i);
  });

  it("propagates timeout errors", async () => {
    mockWebFetch.mockRejectedValueOnce(
      new Error("web.fetch: request timed out after 10000ms"),
    );

    await expect(
      webFetchHandler(
        {
          url: "https://slow.example.com",
          extractMarkdown: true,
          timeout: 10000,
        },
        validCtx,
      ),
    ).rejects.toThrow(/timed out/i);
  });
});

// ── extractMarkdownFromHtml — unit tests ──────────────────────────────────────
// These use the REAL implementation (not mocked) to verify HTML stripping logic.

describe("extractMarkdownFromHtml — HTML stripping", () => {
  it("extracts <title> tag content", () => {
    const html =
      "<html><head><title>My Page Title</title></head><body></body></html>";
    const { title } = extractMarkdownFromHtml(html);
    expect(title).toBe("My Page Title");
  });

  it("removes <script> blocks entirely", () => {
    const html = "<body><script>alert('xss')</script><p>Hello world</p></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).not.toContain("alert");
    expect(content).not.toContain("xss");
    expect(content).toContain("Hello world");
  });

  it("removes <style> blocks entirely", () => {
    const html =
      "<body><style>.red { color: red; }</style><p>Visible text</p></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).not.toContain("color:");
    expect(content).toContain("Visible text");
  });

  it("removes <nav> blocks entirely", () => {
    const html =
      "<body><nav><a href='/'>Home</a><a href='/about'>About</a></nav><p>Main content</p></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).not.toContain("Home");
    expect(content).not.toContain("About");
    expect(content).toContain("Main content");
  });

  it("removes <footer> blocks entirely", () => {
    const html = "<body><p>Article</p><footer>Copyright 2024</footer></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).not.toContain("Copyright");
    expect(content).toContain("Article");
  });

  it("removes <header> blocks entirely", () => {
    const html = "<body><header>Site Header</header><p>Content</p></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).not.toContain("Site Header");
    expect(content).toContain("Content");
  });

  it("converts <h1> to markdown # heading", () => {
    const html = "<body><h1>Main Title</h1></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toMatch(/^# Main Title/m);
  });

  it("converts <h2> to markdown ## heading", () => {
    const html = "<body><h2>Section</h2></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toMatch(/^## Section/m);
  });

  it("converts <h3> through <h6> to corresponding markdown headings", () => {
    const html = "<body><h3>A</h3><h4>B</h4><h5>C</h5><h6>D</h6></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toMatch(/^### A/m);
    expect(content).toMatch(/^#### B/m);
    expect(content).toMatch(/^##### C/m);
    expect(content).toMatch(/^###### D/m);
  });

  it("converts <p> tags to paragraphs separated by blank lines", () => {
    const html = "<body><p>First paragraph.</p><p>Second paragraph.</p></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain("First paragraph.");
    expect(content).toContain("Second paragraph.");
    // The two paragraphs should be separated by a blank line
    expect(content).toMatch(/First paragraph\.\s+\n\s*Second paragraph\./);
  });

  it("converts <br> to newlines", () => {
    const html = "<body><p>Line one<br>Line two</p></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain("Line one");
    expect(content).toContain("Line two");
  });

  it("converts <li> to markdown list items", () => {
    const html = "<body><ul><li>Apple</li><li>Banana</li></ul></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toMatch(/^- Apple/m);
    expect(content).toMatch(/^- Banana/m);
  });

  it("converts <a> tags to markdown links", () => {
    const html =
      '<body><p>Visit <a href="https://example.com">Example</a></p></body>';
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain("[Example](https://example.com)");
  });

  it("decodes common HTML entities", () => {
    const html =
      "<body><p>A &amp; B &lt;tag&gt; &quot;quoted&quot; &nbsp;space</p></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain('A & B <tag> "quoted"');
  });

  it("strips remaining tags leaving only text", () => {
    const html = "<body><div class='wrapper'><span>Text</span></div></body>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toBe("Text");
    expect(content).not.toContain("<div");
    expect(content).not.toContain("<span");
  });

  it("returns empty title when no <title> tag is present", () => {
    const html = "<body><p>Content without title</p></body>";
    const { title } = extractMarkdownFromHtml(html);
    expect(title).toBe("");
  });
});
