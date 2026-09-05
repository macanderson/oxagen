import { defineDocs, defineConfig } from "fumadocs-mdx/config";

// Two independent doc collections sharing one loader tree: the platform docs
// (mirrored from @oxagen/docs' content) and Stella's docs (mirrored from the
// stella repo's website/content, which stays untouched — see
// content/docs/README.md for the sync notes). Both render through the same
// `source` in src/lib/source.ts, merged at /docs.
export const docs = defineDocs({
  dir: "content/docs",
});

export default defineConfig();
