// @vitest-environment jsdom
// The shell names the page a route error boundary titles (audit-prompt check
// 22): "Fleet could not be loaded" as the mock prints it, read off the path
// the way the sidebar lights its current item, and the generic title on a
// path no nav item holds.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { RouteError } from "@/ui/page-states";
import { ShellRoutePageName } from "./route-page-name";

const nav = vi.hoisted(() => ({
  pathname: "/acme/core-platform",
  reads: 0,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => {
    nav.reads += 1;
    return nav.pathname;
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function renderAt(pathname: string) {
  nav.pathname = pathname;
  render(
    <IntlProvider>
      <ShellRoutePageName>
        <RouteError error={new Error("boom")} reset={vi.fn()} />
      </ShellRoutePageName>
    </IntlProvider>,
  );
}

describe("ShellRoutePageName", () => {
  it.each([
    ["/acme/core-platform", "Fleet could not be loaded"],
    ["/acme/core-platform/runs/run_01K5RS7M2E", "Fleet could not be loaded"],
    ["/acme/core-platform/steering", "Steering could not be loaded"],
    ["/acme/billing", "Billing could not be loaded"],
    ["/acme/audit", "Audit could not be loaded"],
  ])("titles a failure on %s with the page's name", (pathname, title) => {
    renderAt(pathname);
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
  });

  // The provider wraps every page outside any <Suspense>. A path read there is
  // runtime data that stops Next.js prerendering a static route (the Skills
  // redirect failed the build that way), so only the boundary may read it.
  it("reads no path while the page renders without an error (negative)", () => {
    nav.reads = 0;
    render(
      <IntlProvider>
        <ShellRoutePageName>
          <p>page body</p>
        </ShellRoutePageName>
      </IntlProvider>,
    );
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(nav.reads).toBe(0);
  });

  it("keeps the generic title on a path no nav item holds (negative)", () => {
    renderAt("/acme/core-platform/nowhere");
    expect(
      screen.getByRole("heading", { name: "This page could not be loaded" }),
    ).toBeInTheDocument();
  });
});
