import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractMarkdownFromHtml, webFetch } from "./fetch";

describe("extractMarkdownFromHtml", () => {
  it("extracts title from <title> tag", () => {
    const { title } = extractMarkdownFromHtml("<html><head><title>Hello World</title></head><body></body></html>");
    expect(title).toBe("Hello World");
  });

  it("returns empty title when no <title> tag", () => {
    const { title } = extractMarkdownFromHtml("<html><body><p>No title here</p></body></html>");
    expect(title).toBe("");
  });

  it("strips script blocks", () => {
    const html = "<p>Visible</p><script>alert('xss')</script><p>Also visible</p>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).not.toContain("alert");
    expect(content).toContain("Visible");
  });

  it("strips style blocks", () => {
    const html = "<p>Text</p><style>.foo { color: red; }</style>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).not.toContain("color");
    expect(content).toContain("Text");
  });

  it("strips nav, footer, and header blocks", () => {
    const html = "<nav>Navigation</nav><main><p>Content</p></main><footer>Footer</footer><header>Header</header>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).not.toContain("Navigation");
    expect(content).not.toContain("Footer");
    expect(content).not.toContain("Header");
    expect(content).toContain("Content");
  });

  it("converts h1–h6 to markdown headings", () => {
    const html = "<h1>Title</h1><h2>Sub</h2><h3>Sub-sub</h3>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain("# Title");
    expect(content).toContain("## Sub");
    expect(content).toContain("### Sub-sub");
  });

  it("converts anchor tags to markdown links", () => {
    const html = '<a href="https://example.com">Click here</a>';
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain("[Click here](https://example.com)");
  });

  it("converts list items to markdown list", () => {
    const html = "<ul><li>Item one</li><li>Item two</li></ul>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain("- Item one");
    expect(content).toContain("- Item two");
  });

  it("decodes HTML entities", () => {
    const html = "<p>A &amp; B &lt;ok&gt; &quot;hi&quot; &#39;there&#39;</p>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain("A & B <ok> \"hi\" 'there'");
  });

  it("decodes numeric HTML entities", () => {
    const html = "<p>&#65;&#66;&#67;</p>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain("ABC");
  });

  it("decodes hex HTML entities", () => {
    const html = "<p>&#x41;&#x42;&#x43;</p>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain("ABC");
  });

  it("collapses excessive blank lines", () => {
    const html = "<p>First</p>\n\n\n\n\n<p>Second</p>";
    const { content } = extractMarkdownFromHtml(html);
    const blankLineCount = (content.match(/\n\n\n/g) ?? []).length;
    expect(blankLineCount).toBe(0);
  });

  it("strips all remaining HTML tags", () => {
    const html = "<div><span class='foo'>Just text</span></div>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).not.toMatch(/<[^>]+>/);
    expect(content).toContain("Just text");
  });

  it("handles empty string", () => {
    const { title, content } = extractMarkdownFromHtml("");
    expect(title).toBe("");
    expect(content).toBe("");
  });

  it("handles non-breaking spaces", () => {
    const html = "<p>Hello&nbsp;World</p>";
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain("Hello World");
  });
});

describe("webFetch", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws on invalid URL", async () => {
    await expect(webFetch({ url: "not-a-url", extractMarkdown: false, timeout: 5000 }))
      .rejects.toThrow('invalid URL "not-a-url"');
  });

  it("throws on non-http/https scheme", async () => {
    await expect(webFetch({ url: "ftp://example.com/file", extractMarkdown: false, timeout: 5000 }))
      .rejects.toThrow('URL scheme "ftp:" is not allowed');
  });

  it("returns raw content when extractMarkdown is false", async () => {
    const mockHtml = "<html><body><p>Hello</p></body></html>";
    globalThis.fetch = vi.fn().mockResolvedValue({
      text: async () => mockHtml,
      status: 200,
    } as Response);

    const result = await webFetch({ url: "https://example.com", extractMarkdown: false, timeout: 5000 });
    expect(result.content).toBe(mockHtml);
    expect(result.statusCode).toBe(200);
    expect(result.url).toBe("https://example.com");
  });

  it("extracts markdown when extractMarkdown is true", async () => {
    const mockHtml = "<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World</p></body></html>";
    globalThis.fetch = vi.fn().mockResolvedValue({
      text: async () => mockHtml,
      status: 200,
    } as Response);

    const result = await webFetch({ url: "https://example.com", extractMarkdown: true, timeout: 5000 });
    expect(result.title).toBe("Test Page");
    expect(result.content).toContain("# Hello");
    expect(result.content).toContain("World");
  });

  it("throws on timeout via AbortError", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

    await expect(webFetch({ url: "https://example.com", extractMarkdown: false, timeout: 100 }))
      .rejects.toThrow("timed out after 100ms");
  });

  it("re-throws non-abort fetch errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

    await expect(webFetch({ url: "https://example.com", extractMarkdown: false, timeout: 5000 }))
      .rejects.toThrow("Network failure");
  });

  it("includes wordCount and fetchedAt in response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      text: async () => "one two three",
      status: 200,
    } as Response);

    const result = await webFetch({ url: "https://example.com", extractMarkdown: false, timeout: 5000 });
    expect(result.wordCount).toBe(3);
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
