import { defineDocs, defineConfig } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // Emit the `_markdown` export (stringified MDAST) for every page so
    // `page.data.getText("processed")` can serve clean, JSX-stripped Markdown.
    // Consumed by the raw-markdown route, llms.txt, and llms-full.txt.
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig();
