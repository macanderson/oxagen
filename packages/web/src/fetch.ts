export interface FetchOptions {
  /** Absolute URL to fetch. Must use the http:// or https:// scheme. */
  url: string;
  /** When true, strip HTML and return markdown; when false, return the body verbatim. */
  extractMarkdown: boolean;
  /** Milliseconds to wait for response headers. Does not bound the body read. */
  timeout: number;
}

export interface FetchResponse {
  /**
   * The URL that was REQUESTED, echoed back — not the URL that answered.
   * Redirects are followed and not reported, so this can name a different
   * origin than the one `content` actually came from.
   */
  url: string;
  /**
   * Text of the first `<title>` element, entity-decoded. Empty when
   * `extractMarkdown` is false or the document has no title.
   */
  title: string;
  /** Extracted markdown, or the raw body. Always untrusted text. */
  content: string;
  /** Whitespace-separated token count of `content`. */
  wordCount: number;
  /** ISO 8601 timestamp of when the body finished downloading. */
  fetchedAt: string;
  /**
   * HTTP status of the response. Non-2xx is NOT an error here: a 404 or 500
   * body is extracted and returned like any other, so callers that care must
   * check this field themselves.
   */
  statusCode: number;
}

/**
 * Strip HTML and convert it to readable markdown.
 *
 * Block tags (script, style, nav, footer, header) are matched as
 * open/close pairs and dropped before the generic tag strip. This is a
 * regex pass, not a parser, so it is best-effort and not a sanitizer:
 *
 *   - a nested block (`<nav><nav>a</nav>b</nav>`) closes on the inner
 *     `</nav>`, so the outer tail (`b`) survives into the output;
 *   - an end tag the pattern does not match (`</script >`, an unclosed
 *     `<style>`) leaves the block body in place as plain text.
 *
 * The title is read from the ORIGINAL html, before the block strip, so a
 * `<title>` written inside a script or comment can win over the real one.
 *
 * Two costs scale badly with input size, and the caller controls the input:
 * the block-strip and anchor patterns both rescan toward the end of the
 * string from every candidate start, so markup that never closes (a run of
 * `<script` or `<a ` with no matching end) costs time quadratic in the body
 * length. `webFetch` puts no cap on body size, so pass hostile input at your
 * own risk.
 *
 * Callers must treat the returned content as untrusted text. `href` values
 * are copied into markdown links verbatim and are not scheme-checked.
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

/**
 * The named references this extractor decodes.
 *
 * Read it with `Object.hasOwn`, never a bare index. A plain object literal
 * inherits `constructor`, `toString`, `valueOf` and friends from
 * `Object.prototype`, and every one of those names matches the `[a-zA-Z]+`
 * branch of the entity pattern — so an indexed lookup would resolve
 * `&constructor;` to a function and splice its source text into the output.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const MAX_CODE_POINT = 0x10ffff;

/**
 * Turn a numeric character reference into its character, or give back the
 * reference exactly as written when the number is not a real code point.
 *
 * `String.fromCodePoint` throws a RangeError above U+10FFFF, and it happily
 * returns a lone surrogate (U+D800–U+DFFF) that is not valid UTF-8 and gets
 * rejected further down the pipeline. Hostile markup can contain either, so
 * both are left as literal text instead.
 */
function codePointOrRaw(codePoint: number, raw: string): string {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > MAX_CODE_POINT ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return raw;
  }
  return String.fromCodePoint(codePoint);
}

/**
 * Decode the HTML entities this extractor cares about, in a single pass.
 *
 * A single pass is the point. Decoding `&amp;` and then `&lt;` in separate
 * passes turns `&amp;lt;` into `<`, so text an author deliberately escaped
 * comes back out as markup. One pass decodes each reference exactly once.
 *
 * Unrecognised names (`&copy;`) are left as written.
 */
function decodeEntities(str: string): string {
  return str.replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g,
    (
      match: string,
      hex: string | undefined,
      dec: string | undefined,
      name: string | undefined,
    ) => {
      if (hex !== undefined) return codePointOrRaw(parseInt(hex, 16), match);
      if (dec !== undefined) return codePointOrRaw(parseInt(dec, 10), match);
      if (name !== undefined && Object.hasOwn(NAMED_ENTITIES, name)) {
        return NAMED_ENTITIES[name] ?? match;
      }
      return match;
    },
  );
}

/**
 * Count whitespace-separated tokens.
 *
 * On the `extractMarkdown: false` path this runs over raw HTML, so the
 * count includes tag text and is an upper bound, not a prose word count.
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Fetch a URL and optionally extract clean markdown content.
 *
 * Only http:// and https:// are allowed, to stop the fetch from being
 * used to reach other schemes (file://, data://, etc).
 *
 * What this does NOT do, because callers keep assuming otherwise:
 *
 *   - No host check. The scheme allowlist says nothing about where the
 *     request goes, and redirects are followed, so a caller-supplied URL
 *     still reaches loopback, RFC-1918 ranges, and the cloud metadata
 *     endpoint. See the SSRF note on the `fetch_web_page` contract in
 *     packages/oxagen/src/contracts/web.fetch.ts.
 *   - `options.timeout` bounds the wait for response HEADERS only. The
 *     timer is cleared before the body is read, so a server that trickles
 *     bytes can hold the call open indefinitely.
 *   - No cap on response size. The whole body is buffered into a string.
 *
 * Treat the returned `content` as untrusted text.
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
