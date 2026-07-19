import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

/**
 * GET /llms-full.txt — every docs page's processed Markdown, concatenated into
 * a single document. Intended for LLMs that can ingest the whole corpus at
 * once. Pages are emitted in sidebar order (`source.getPages()`), separated by
 * a horizontal rule.
 */
export async function GET() {
  const pages = source.getPages();
  const rendered = await Promise.all(pages.map(getLLMText));

  return new Response(rendered.join("\n\n---\n\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
