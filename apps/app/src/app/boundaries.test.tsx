// @vitest-environment jsdom
// The route boundaries that stand in for a page: the not-found pages under
// `[org]` and `[org]/[ws]` draw the shared not-found state inside the shell,
// with one way back to the Organization page or to Fleet; the root not-found
// and the global error, which render outside the shell, draw the same state
// shape with the page's one h1.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import { renderPage } from "@/test/render-page";

const route = vi.hoisted(() => {
  const params: Record<string, string> = { org: "acme", ws: "core-platform" };
  return { pathname: "/acme/core-platform/runs/run_missing", params };
});
vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useParams: () => route.params,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));

const { default: RootNotFound } = await import("./not-found");
const { default: GlobalError } = await import("./global-error");
const { default: OrganizationNotFound } = await import("./[org]/not-found");
const { default: WorkspaceNotFound } = await import("./[org]/[ws]/not-found");

afterEach(() => {
  cleanup();
  route.pathname = "/acme/core-platform/runs/run_missing";
  route.params = { org: "acme", ws: "core-platform" };
});

describe("[org]/[ws]/not-found", () => {
  it("draws the not-found state with the way back to Fleet", () => {
    render(
      <IntlProvider>
        <WorkspaceNotFound />
      </IntlProvider>,
    );
    const state = screen.getByTestId("page-not-found");
    expect(state).toHaveTextContent(
      "Nothing in workspace core-platform is at /acme/core-platform/runs/run_missing.",
    );
    expect(
      within(state).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
  });
});

describe("[org]/not-found", () => {
  it("draws the not-found state with the way back to the Organization page", () => {
    route.pathname = "/acme/audit/nothing";
    route.params = { org: "acme" };
    render(
      <IntlProvider>
        <OrganizationNotFound />
      </IntlProvider>,
    );
    const state = screen.getByTestId("page-not-found");
    expect(
      within(state).getByRole("link", { name: "Back to Organization" }),
    ).toHaveAttribute("href", "/acme");
    expect(
      within(state).queryByRole("link", { name: "Back to Fleet" }),
    ).toBeNull();
  });
});

describe("the root not-found page", () => {
  it("draws the state shape with its title as the page's one h1 and one way home", async () => {
    const container = await renderPage(await RootNotFound());
    const state = screen.getByTestId("not-found");
    expect(
      within(state).getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeInTheDocument();
    expect(state).toHaveTextContent(
      "This address does not match a page you can open.",
    );
    expect(
      within(state).getByRole("link", { name: "Go to Oxagen" }),
    ).toHaveAttribute("href", "/");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(
      state.querySelector("[data-state-icon]")?.getAttribute("data-state-icon"),
    ).toBe("neutral");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    await expectNoAxe(document.body);
  });
});

/** The one child an element holds: `<html>`'s `<body>`, then `<body>`'s `<main>`. */
function childOf(node: ReactNode): ReactNode {
  if (!isValidElement<{ children: ReactNode }>(node))
    throw new Error("expected an element");
  return node.props.children;
}

describe("the global error", () => {
  // The boundary is its own document (<html> and <body>), which cannot mount
  // inside a test container, so the test mounts the <main> its body holds.
  // It reads no hook, so calling it for its tree is calling it as Next does.
  function renderBoundary(props: { retry?: () => void; reset: () => void }) {
    const html = GlobalError({ error: new Error("boom"), ...props });
    render(childOf(childOf(html)));
    return screen.getByTestId("global-error");
  }

  it("draws the error state in the failed tone with its own h1", () => {
    const state = renderBoundary({ reset: vi.fn(), retry: vi.fn() });
    expect(
      within(state).getByRole("heading", {
        level: 1,
        name: "Something went wrong",
      }),
    ).toBeInTheDocument();
    expect(state).toHaveTextContent(
      "Oxagen hit an unexpected error. Reload the page to try again.",
    );
    expect(
      state.querySelector("[data-state-icon]")?.getAttribute("data-state-icon"),
    ).toBe("failed");
  });

  it("tries the failed tree again with retry, which reads it again", async () => {
    const retry = vi.fn();
    const reset = vi.fn();
    const state = renderBoundary({ reset, retry });
    await userEvent.click(
      within(state).getByRole("button", { name: "Try again" }),
    );
    expect(retry).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
  });

  it("falls back to reset when no retry is passed (negative)", async () => {
    const reset = vi.fn();
    const state = renderBoundary({ reset });
    await userEvent.click(
      within(state).getByRole("button", { name: "Try again" }),
    );
    expect(reset).toHaveBeenCalledOnce();
  });
});
