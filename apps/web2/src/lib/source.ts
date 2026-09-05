import { docs } from "@/.source/server";
import { loader } from "fumadocs-core/source";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

type TreeNode = (typeof source.pageTree)["children"][number];

/**
 * Depth-first page URLs under a set of page-tree nodes, respecting each
 * folder's `meta.json` `pages` order (a folder's index page first, then its
 * children). `source.getPages()` returns pages in filesystem scan order, not
 * this order, so anything that must match the rendered sidebar (llms.txt,
 * llms-full.txt, section-landing redirects) walks the tree instead.
 */
export function collectOrderedPageUrls(nodes: readonly TreeNode[]): string[] {
  const urls: string[] = [];
  for (const node of nodes) {
    if (node.type === "page") urls.push(node.url);
    else if (node.type === "folder") {
      if (node.index) urls.push(node.index.url);
      urls.push(...collectOrderedPageUrls(node.children));
    }
  }
  return urls;
}
