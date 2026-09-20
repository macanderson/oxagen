import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { z } from "zod";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // The default frontmatter plus `date`, which the release pages carry
    // (`releases/v*.mdx`, written by tools/scripts/release.ts) and the
    // releases index reads to say when each version shipped.
    schema: z.object({
      title: z.string(),
      description: z.string().optional(),
      icon: z.string().optional(),
      full: z.boolean().optional(),
      date: z.string().optional(),
    }),
    // Emit the `_markdown` export (stringified MDAST) for every page so
    // `page.data.getText("processed")` can serve clean, JSX-stripped Markdown.
    // Consumed by the raw-markdown route, llms.txt, and llms-full.txt.
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig();
