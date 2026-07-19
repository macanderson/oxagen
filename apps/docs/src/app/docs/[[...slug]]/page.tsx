import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import { getMDXComponents } from "@/mdx-components";
import { PageActions } from "@/components/docs/page-actions";
import { source } from "@/lib/source";

// Page-tree node type, inferred from the loader output so it stays in sync with
// fumadocs-core without importing internal type paths.
type TreeNode = (typeof source.pageTree)["children"][number];

// Collect page URLs in sidebar order (depth-first, respecting meta.json `pages`).
// A folder contributes its index page first (if any), then its children.
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

// A section folder with no index page (e.g. /docs/connections) would otherwise
// 404. Resolve it to the section's first page so section roots are always
// navigable. Folders that DO have an index.mdx are served directly by getPage.
function resolveSectionLanding(slug: string[]): string | undefined {
  if (slug.length === 0) return undefined;
  const prefix = `/docs/${slug.join("/")}`;
  return collectPageUrls(source.pageTree.children).find((url) =>
    url.startsWith(`${prefix}/`),
  );
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) {
    const landing = resolveSectionLanding(params.slug ?? []);
    if (landing) redirect(landing);
    notFound();
  }

  const MDX = page.data.body;
  const slug = params.slug ?? [];
  // Raw-Markdown endpoint for this page (see src/app/llms.mdx/docs/[[...slug]]).
  // page.url is `/docs/…`, so the raw route is that path under `/llms.mdx`.
  const markdownUrl = `/llms.mdx${page.url}`;
  const fileStem = slug.length > 0 ? slug.join("-") : "index";

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <div className="flex items-start justify-between gap-4">
        <DocsTitle>{page.data.title}</DocsTitle>
        <PageActions markdownUrl={markdownUrl} fileStem={fileStem} />
      </div>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) {
    const landing = resolveSectionLanding(params.slug ?? []);
    if (landing) redirect(landing);
    notFound();
  }

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
