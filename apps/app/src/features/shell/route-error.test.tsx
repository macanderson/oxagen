// @vitest-environment jsdom
// The route error boundaries: each names its page, prints the code the kernel
// gives that page's unclassified failure, keeps the page's landmark and h1,
// hands Try again to Next's `retry`, and prints the digest as the trace id.
// Each route's `error.tsx` is wired to the boundary for its page.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_FAILURES, type PageKey } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import * as boundaries from "./route-error";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
// The barrel reaches server modules; the routes need only its boundaries.
vi.mock("@/features/shell", async () => await import("./route-error"));

afterEach(cleanup);

type Boundary = ComponentType<{
  error: Error & { digest?: string };
  retry: () => void;
}>;

const ROWS: readonly [
  string,
  Boundary,
  PageKey,
  string,
  () => Promise<{ default: unknown }>,
][] = [
  ["organization", boundaries.ShellRouteError, "shell", "This page", () => import("@/app/[org]/error")],
  ["workspace", boundaries.ShellRouteError, "shell", "This page", () => import("@/app/[org]/[ws]/error")],
  ["fleet", boundaries.FleetRouteError, "fleet", "Fleet", () => import("@/app/[org]/[ws]/(fleet)/error")],
  ["run", boundaries.RunRouteError, "run", "Run", () => import("@/app/[org]/[ws]/runs/[run]/error")],
  ["agents", boundaries.AgentsRouteError, "agents", "Agents", () => import("@/app/[org]/[ws]/agents/error")],
  ["register", boundaries.RegisterRouteError, "onboarding", "Register an agent", () => import("@/app/[org]/[ws]/register/[step]/error")],
  ["spend", boundaries.SpendRouteError, "spend", "Spend", () => import("@/app/[org]/[ws]/spend/[[...tab]]/error")],
  ["steering", boundaries.SteeringRouteError, "steering", "Steering", () => import("@/app/[org]/[ws]/steering/error")],
  ["mandate", boundaries.MandateRouteError, "mandates", "Mandate", () => import("@/app/[org]/[ws]/mandates/[mandate]/error")],
  ["tools", boundaries.ToolsRouteError, "tools", "Tools", () => import("@/app/[org]/[ws]/tools/error")],
  ["repositories", boundaries.RepositoriesRouteError, "repositories", "Repositories", () => import("@/app/[org]/[ws]/repositories/[[...tab]]/error")],
  ["runtimes", boundaries.RuntimesRouteError, "runtimes", "Runtimes", () => import("@/app/[org]/[ws]/runtimes/error")],
  ["billing", boundaries.BillingRouteError, "billing", "Billing", () => import("@/app/[org]/billing/error")],
  ["audit", boundaries.AuditRouteError, "audit", "Audit", () => import("@/app/[org]/audit/error")],
];

describe("route error boundaries", () => {
  it.each(ROWS)(
    "%s names its page and its code, and is its route's error.tsx",
    async (_route, Boundary, page, what, route) => {
      const { container } = render(
        <IntlProvider>
          <Boundary error={new Error("boom")} retry={vi.fn()} />
        </IntlProvider>,
      );
      const main = container.querySelector("main");
      expect(main).toHaveAttribute("id", "main");
      expect(
        within(main as HTMLElement).getByRole("heading", {
          level: 1,
          name: `${what} could not be loaded`,
        }),
      ).toBeVisible();
      const { code, status } = PAGE_FAILURES[page].error;
      expect(screen.getByRole("alert").querySelector("code")).toHaveTextContent(
        `${status} ${code}`,
      );
      expect((await route()).default).toBe(Boundary);
    },
  );

  it("hands Try again to retry and prints the digest as the trace id", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { container } = render(
      <IntlProvider>
        <boundaries.FleetRouteError
          error={Object.assign(new Error("boom"), { digest: "2718281828" })}
          retry={retry}
        />
      </IntlProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByTestId("page-error-trace")).toHaveTextContent(
      "trace 2718281828 · region not recorded",
    );
    expect(container).not.toHaveTextContent("boom");
    await expectNoAxe(container);
  });
});
