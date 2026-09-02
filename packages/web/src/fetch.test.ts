import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractMarkdownFromHtml, webFetch } from "./fetch";

describe("extractMarkdownFromHtml", () => {
  it("extracts title from <title> tag", () => {
    const { title } = extractMarkdownFromHtml(
      "<html><head><title>Hello World</title></head><body></body></html>",
    );
    expect(title).toBe("Hello World");
  });

  it("returns empty title when no <title> tag", () => {
    const { title } = extractMarkdownFromHtml(
      "<html><body><p>No title here</p></body></html>",
    );
    expect(title).toBe("");
  });

  it("strips script blocks", () => {
    const html =
      "<p>Visible</p><script>alert('xss')</script><p>Also visible</p>";
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
    const html =
      "<nav>Navigation</nav><main><p>Content</p></main><footer>Footer</footer><header>Header</header>";
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

  it("decodes each entity exactly once", () => {
    // `&amp;lt;` is an author writing a literal "&lt;". Decoding &amp; and
    // then &lt; in separate passes would resurrect it as "<".
    const { content } = extractMarkdownFromHtml("<p>&amp;lt;b&amp;gt;</p>");
    expect(content).toContain("&lt;b&gt;");
    expect(content).not.toContain("<b>");
  });

  it("leaves out-of-range numeric references alone instead of throwing", () => {
    // String.fromCodePoint throws a RangeError above U+10FFFF.
    const html = "<p>&#1114112; &#99999999999; &#xFFFFFFF;</p>";
    expect(() => extractMarkdownFromHtml(html)).not.toThrow();
    const { content } = extractMarkdownFromHtml(html);
    expect(content).toContain("&#1114112;");
    expect(content).toContain("&#xFFFFFFF;");
  });

  it("leaves lone surrogate references alone", () => {
    // U+D800 is not valid UTF-8 on its own and breaks downstream encoders.
    const { content } = extractMarkdownFromHtml("<p>&#xD800;</p>");
    expect(content).toBe("&#xD800;");
  });

  it("leaves unrecognised named entities as written", () => {
    const { content } = extractMarkdownFromHtml("<p>&copy; 2026</p>");
    expect(content).toContain("&copy; 2026");
  });

  it("does not resolve named entities off Object.prototype", () => {
    // `constructor`, `toString` and friends all match the [a-zA-Z]+ branch of
    // the entity pattern. An indexed lookup on a plain object literal finds
    // them on the prototype chain and returns a function, which the replacer
    // stringifies into "function Object() { [native code] }".
    const { content } = extractMarkdownFromHtml(
      "<p>&constructor; &toString; &valueOf; &hasOwnProperty;</p>",
    );
    expect(content).toBe("&constructor; &toString; &valueOf; &hasOwnProperty;");
    expect(content).not.toContain("native code");
  });

  it("does not resolve a prototype-inherited name in the title", () => {
    const { title } = extractMarkdownFromHtml("<title>&constructor;</title>");
    expect(title).toBe("&constructor;");
  });

  it("does not throw on an out-of-range reference inside the title", () => {
    expect(() =>
      extractMarkdownFromHtml("<title>&#1114112;</title>"),
    ).not.toThrow();
  });

  it("leaks the body of a block whose end tag does not match the pattern", () => {
    // Documented limitation: this is a regex pass, not a parser. `</script >`
    // is a valid end tag that the strip pattern does not match.
    const { content } = extractMarkdownFromHtml(
      "<script>secret()</script >After",
    );
    expect(content).toContain("secret()");
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
    await expect(
      webFetch({ url: "not-a-url", extractMarkdown: false, timeout: 5000 }),
    ).rejects.toThrow('invalid URL "not-a-url"');
  });

  it("throws on non-http/https scheme", async () => {
    await expect(
      webFetch({
        url: "ftp://example.com/file",
        extractMarkdown: false,
        timeout: 5000,
      }),
    ).rejects.toThrow('URL scheme "ftp:" is not allowed');
  });

  it("returns raw content when extractMarkdown is false", async () => {
    const mockHtml = "<html><body><p>Hello</p></body></html>";
    globalThis.fetch = vi.fn().mockResolvedValue({
      text: async () => mockHtml,
      status: 200,
    } as Response);

    const result = await webFetch({
      url: "https://example.com",
      extractMarkdown: false,
      timeout: 5000,
    });
    expect(result.content).toBe(mockHtml);
    expect(result.statusCode).toBe(200);
    expect(result.url).toBe("https://example.com");
  });

  it("extracts markdown when extractMarkdown is true", async () => {
    const mockHtml =
      "<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World</p></body></html>";
    globalThis.fetch = vi.fn().mockResolvedValue({
      text: async () => mockHtml,
      status: 200,
    } as Response);

    const result = await webFetch({
      url: "https://example.com",
      extractMarkdown: true,
      timeout: 5000,
    });
    expect(result.title).toBe("Test Page");
    expect(result.content).toContain("# Hello");
    expect(result.content).toContain("World");
  });

  it("throws on timeout via AbortError", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );

    await expect(
      webFetch({
        url: "https://example.com",
        extractMarkdown: false,
        timeout: 100,
      }),
    ).rejects.toThrow("timed out after 100ms");
  });

  it("re-throws non-abort fetch errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

    await expect(
      webFetch({
        url: "https://example.com",
        extractMarkdown: false,
        timeout: 5000,
      }),
    ).rejects.toThrow("Network failure");
  });

  it("includes wordCount and fetchedAt in response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      text: async () => "one two three",
      status: 200,
    } as Response);

    const result = await webFetch({
      url: "https://example.com",
      extractMarkdown: false,
      timeout: 5000,
    });
    expect(result.wordCount).toBe(3);
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
