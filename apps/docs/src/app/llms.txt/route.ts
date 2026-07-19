import type { ReactNode } from "react";
import { source } from "@/lib/source";

// Matches sitemap.ts — the canonical production origin for docs. Keeping the
// two in sync means every llms.txt link resolves to a real, crawlable URL.
const BASE_URL = "https://docs.oxagen.sh";

const SITE_NAME = "Oxagen Docs";
const SITE_DESCRIPTION =
  "Documentation for Oxagen — the metered, governed, graph-grounded control plane for teams that build and resell AI agents.";

// Page-tree node type, inferred from the loader output so it stays in sync with
// fumadocs-core without importing internal type paths.
type TreeNode = (typeof source.pageTree)["children"][number];

/** Flatten a ReactNode label (usually a plain string from meta.json) to text. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return props?.children ? nodeText(props.children) : "";
  }
  return "";
}

/** Absolute raw-Markdown URL for a docs page URL (`/docs/…` → `/llms.mdx/docs/…`). */
function rawMarkdownUrl(pageUrl: string): string {
  return `${BASE_URL}/llms.mdx${pageUrl}`;
}

// Real pages keyed by URL — the tree carries structure/order, this carries the
// frontmatter (title + description) we actually render per line.
const pagesByUrl = new Map(source.getPages().map((page) => [page.url, page]));

/** One `- [Title](rawUrl): description` line, or null if the URL isn't a page. */
function pageLine(url: string): string | null {
  const page = pagesByUrl.get(url);
  if (!page) return null;
  const description = page.data.description ? `: ${page.data.description}` : "";
  return `- [${page.data.title}](${rawMarkdownUrl(page.url)})${description}`;
}

/** Depth-first page URLs under a node, index page first (sidebar order). */
function collectPageUrls(nodes: readonly TreeNode[]): string[] {
  const urls: string[] = [];
  for (const node of nodes) {
    if (node.type === "page") urls.push(node.url);
    else if (node.type === "folder") {
      if (node.index) urls.push(node.index.url);
      urls.push(...collectPageUrls(node.children));
    }
  }
  return urls;
}

/**
 * GET /llms.txt — the LLM-friendly site index.
 *
 * Structure mirrors the docs sidebar: top-level pages under "Overview", then
 * one `##` section per top-level folder (CLI, Stella, Configuration, …), each
 * listing its pages with a link to the raw-Markdown endpoint.
 */
export function GET() {
  const lines: string[] = [`# ${SITE_NAME}`, "", `> ${SITE_DESCRIPTION}`, ""];

  // Top-level pages (index, getting-started) that live outside any folder.
  const rootPageLines = source.pageTree.children
    .filter(
      (node): node is Extract<TreeNode, { type: "page" }> =>
        node.type === "page",
    )
    .map((node) => pageLine(node.url))
    .filter((line): line is string => line !== null);

  if (rootPageLines.length > 0) {
    lines.push("## Overview", "", ...rootPageLines, "");
  }

  for (const node of source.pageTree.children) {
    if (node.type !== "folder") continue;
    const sectionTitle = nodeText(node.name).trim() || "Section";
    const urls = collectPageUrls([node]);
    const sectionLines = urls
      .map(pageLine)
      .filter((line): line is string => line !== null);
    if (sectionLines.length === 0) continue;
    lines.push(`## ${sectionTitle}`, "", ...sectionLines, "");
  }

  return new Response(`${lines.join("\n").trimEnd()}\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
