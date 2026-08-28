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
 * Strip HTML and convert it to readable markdown.
 *
 * Block tags (script, style, nav, footer, header) are removed before
 * the generic tag strip, so their contents never leak into the output.
 */
export function extractMarkdownFromHtml(html: string): {
  title: string;
  content: string;
} {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]?.trim() ?? "") : "";

  let text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, "");

  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<p[^>]*>/gi, "");

  text = text.replace(/<br\s*\/?>/gi, "\n");

  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

  text = text.replace(
    /<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    "[$2]($1)",
  );

  text = text.replace(/<[^>]+>/g, "");

  text = decodeEntities(text);

  // Collapse runs of 3+ newlines to exactly one blank line.
  text = text.replace(/\n{3,}/g, "\n\n");

  text = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  return { title, content: text };
}

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

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Fetch a URL and optionally extract clean markdown content.
 *
 * Only http:// and https:// are allowed, to stop the fetch from being
 * used to reach other schemes (file://, data://, etc).
 */
export async function webFetch(options: FetchOptions): Promise<FetchResponse> {
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
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.5,*/*;q=0.1",
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
