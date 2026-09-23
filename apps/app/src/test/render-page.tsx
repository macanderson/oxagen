// Test support for route files: prerender a page (Server Components, Suspense
// boundaries and client islands alike) into the document, and assert that the
// page names itself once — generateMetadata's title is the page's one h1
// (ARCHITECTURE.md §1.2). Test files that use it run in jsdom.
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { prerender } from "react-dom/static";
import { expect } from "vitest";
import { IntlProvider } from "./intl";

export type RouteProps<P extends object> = {
  params: Promise<P>;
  searchParams: Promise<Record<string, string>>;
};

export type PageModule<P extends object> = {
  default: (props: RouteProps<P>) => ReactNode | Promise<ReactNode>;
  generateMetadata: (props: RouteProps<P>) => Promise<Metadata>;
};

export function routeProps<P extends object>(
  params: P,
  searchParams: Record<string, string> = {},
): RouteProps<P> {
  return {
    params: Promise.resolve(params),
    searchParams: Promise.resolve(searchParams),
  };
}

/** Waits for every boundary, mounts the HTML as the whole document body, and fails on any render error. */
export async function renderPage(page: ReactNode): Promise<HTMLElement> {
  const errors: unknown[] = [];
  const { prelude } = await prerender(<IntlProvider>{page}</IntlProvider>, {
    onError(error) {
      errors.push(error);
    },
  });
  const html = await new Response(prelude).text();
  if (errors.length > 0) throw errors[0];
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.replaceChildren(container);
  return container;
}

/** Renders `page` at `props`; its one h1 and its generateMetadata title are both `title`. */
export async function expectPageTitle<P extends object>(
  page: PageModule<P>,
  props: RouteProps<P>,
  title: string,
  heading: string = title,
): Promise<HTMLElement> {
  const metadata = await page.generateMetadata(props);
  const container = await renderPage(await page.default(props));
  const headings = [...container.querySelectorAll("h1")].map(
    (h) => h.textContent,
  );
  expect(headings).toEqual([heading]);
  expect(metadata.title).toBe(title);
  return container;
}
