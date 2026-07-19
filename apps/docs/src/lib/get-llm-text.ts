import { source } from "@/lib/source";

type DocsPage = ReturnType<typeof source.getPages>[number];

/**
 * Render a single docs page as a self-contained Markdown document for LLM /
 * machine consumption.
 *
 * The body comes from `getText("processed")`, the JSX-stripped Markdown emitted
 * because `postprocess.includeProcessedMarkdown` is enabled in
 * `source.config.ts`. A heading + URL banner is prepended so the page is
 * legible out of context (e.g. concatenated into `llms-full.txt`).
 */
export async function getLLMText(page: DocsPage): Promise<string> {
  const processed = await page.data.getText("processed");
  const description = page.data.description
    ? `> ${page.data.description}\n\n`
    : "";

  return `# ${page.data.title}

URL: ${page.url}

${description}${processed}`;
}
