export interface FetchOptions {
  url: string;
  extractMarkdown: boolean;
  timeout: number;
}

export interface FetchResponse {
  url: string;
  title: string;
  content: string;
  wordCount: number;
  fetchedAt: string;
  statusCode: number;
}

/**
 * Strip HTML and convert to readable markdown/text.
 *
 * Steps:
 * 1. Remove entire <script>, <style>, <nav>, <footer>, <header> blocks (content + tags).
 * 2. Convert <h1>–<h6> to markdown heading syntax.
 * 3. Convert <p> tags to double-newline-separated paragraphs.
 * 4. Convert <br> / <br /> to newlines.
 * 5. Convert <li> to list items.
 * 6. Convert <a href="...">text</a> to [text](href) markdown links.
 * 7. Strip all remaining HTML tags.
 * 8. Decode common HTML entities.
 * 9. Collapse excessive whitespace and blank lines.
 */
export function extractMarkdownFromHtml(html: string): { title: string; content: string } {
  // Extract <title>
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]?.trim() ?? "") : "";

  // Remove <script ...>...</script> blocks (including inline scripts)
  let text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  // Remove <style ...>...</style> blocks
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  // Remove <nav ...>...</nav> blocks
  text = text.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "");
  // Remove <footer ...>...</footer> blocks
  text = text.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "");
  // Remove <header ...>...</header> blocks
  text = text.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, "");

  // Convert headings to markdown
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  // Convert paragraphs to double-newline separated text
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<p[^>]*>/gi, "");

  // Convert line breaks
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Convert list items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

  // Convert anchor tags to markdown links
  text = text.replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = decodeEntities(text);

  // Collapse excessive blank lines (more than 2 consecutive newlines → 2)
  text = text.replace(/\n{3,}/g, "\n\n");

  // Trim leading/trailing whitespace per line
  text = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  return { title, content: text };
}

/**
 * Decode common HTML entities.
 */
function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_match, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    );
}

/**
 * Count words in a string.
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Fetch a URL and optionally extract clean markdown content.
 *
 * Validates that the URL uses http:// or https:// before fetching.
 * Uses AbortController for timeout enforcement.
 */
export async function webFetch(options: FetchOptions): Promise<FetchResponse> {
  // Validate scheme
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    throw new Error(`web.fetch: invalid URL "${options.url}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `web.fetch: URL scheme "${parsed.protocol}" is not allowed — only http:// and https:// are supported`,
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout);

  let response: Response;
  try {
    response = await fetch(options.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "OxagenBot/1.0 (+https://oxagen.ai)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.5,*/*;q=0.1",
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `web.fetch: request timed out after ${options.timeout}ms for URL "${options.url}"`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const rawText = await response.text();
  const fetchedAt = new Date().toISOString();

  if (!options.extractMarkdown) {
    const wordCount = countWords(rawText);
    return {
      url: options.url,
      title: "",
      content: rawText,
      wordCount,
      fetchedAt,
      statusCode: response.status,
    };
  }

  const { title, content } = extractMarkdownFromHtml(rawText);
  const wordCount = countWords(content);

  return {
    url: options.url,
    title,
    content,
    wordCount,
    fetchedAt,
    statusCode: response.status,
  };
}
