import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";
import { getMDXComponents } from "@/mdx-components";
import { collectOrderedPageUrls, source } from "@/lib/source";

// A section folder with no index page (e.g. /docs/connections) would otherwise
// 404. Resolve it to the section's first page so section roots are always
// navigable. Folders that DO have an index.mdx are served directly by getPage.
function resolveSectionLanding(slug: string[]): string | undefined {
  if (slug.length === 0) return undefined;
  const prefix = `/docs/${slug.join("/")}`;
  return collectOrderedPageUrls(source.pageTree.children).find((url) =>
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

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
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
