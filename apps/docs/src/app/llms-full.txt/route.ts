import { getLLMText } from "@/lib/get-llm-text";
import { collectOrderedPageUrls, source } from "@/lib/source";

/**
 * GET /llms-full.txt — every docs page's processed Markdown, concatenated into
 * a single document. Intended for LLMs that can ingest the whole corpus at
 * once. Pages are emitted in sidebar order, separated by a horizontal rule.
 */
export async function GET() {
  const pagesByUrl = new Map(source.getPages().map((page) => [page.url, page]));
  const orderedPages = collectOrderedPageUrls(source.pageTree.children)
    .map((url) => pagesByUrl.get(url))
    .filter((page) => page !== undefined);
  const rendered = await Promise.all(orderedPages.map(getLLMText));

  return new Response(rendered.join("\n\n---\n\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
