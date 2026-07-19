import { notFound } from "next/navigation";
import { getLLMText } from "@/lib/get-llm-text";
import { source } from "@/lib/source";

/**
 * Serves any docs page as raw Markdown at `/llms.mdx/docs/<slug>` — the same
 * slug space as the human `/docs/<slug>` pages. Powers the per-page "Copy as
 * Markdown" / "Download .md" actions and the links inside `llms.txt`.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
