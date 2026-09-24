// @vitest-environment jsdom
// The three not-found pages: outside any organization, under an organization,
// and under a workspace. Each replaces the page with the shared state, keeps
// the page's landmark and h1, and leads back to the nearest page that exists,
// read from the slugs in the URL.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntlProvider } from "@/test/intl";
import OrganizationNotFound from "./[org]/not-found";
import WorkspaceNotFound from "./[org]/[ws]/not-found";
import NotFound from "./not-found";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ org: "acme", ws: "core" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(cleanup);

describe("not-found pages", () => {
  it.each([
    ["the app", NotFound, "Go to Oxagen", "/"],
    ["an organization", OrganizationNotFound, "Open Organization", "/acme"],
    ["a workspace", WorkspaceNotFound, "Back to Fleet", "/acme/core"],
  ])("under %s leads back to the nearest page", (_scope, Page, label, href) => {
    const { container } = render(
      <IntlProvider>
        <Page />
      </IntlProvider>,
    );
    expect(container.querySelector("main")).toHaveAttribute("id", "main");
    expect(
      screen.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: label })).toHaveAttribute(
      "href",
      href,
    );
  });
});
