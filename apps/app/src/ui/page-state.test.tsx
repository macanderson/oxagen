// @vitest-environment jsdom
// The shared page states: the design's copy, icon tile tone, buttons and the
// list under a denial, with an axe check on each. The two stub dialogs say
// what they would send and that nothing was sent, and neither renders a dead
// button.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  DeniedState,
  EmptyState,
  ErrorState,
  NotFoundState,
  PendingState,
} from "./page-state";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));

afterEach(() => {
  cleanup();
  refresh.mockClear();
});

const view = (node: ReactNode) =>
  render(<IntlProvider>{node}</IntlProvider>);

describe("ErrorState", () => {
  it("names what failed and the code, and says nothing was changed", async () => {
    const { container } = view(
      <ErrorState what="Tools" code="503 tool_registry_unavailable" />,
    );
    const state = screen.getByRole("alert");
    expect(
      within(state).getByRole("heading", {
        level: 2,
        name: "Tools could not be loaded",
      }),
    ).toBeVisible();
    expect(state).toHaveTextContent(
      "The control plane answered 503 tool_registry_unavailable. Nothing was changed. Runs kept recording while this page was down.",
    );
    expect(state.querySelector("code")).toHaveTextContent(
      "503 tool_registry_unavailable",
    );
    expect(screen.getByTestId("page-error-trace")).toHaveTextContent(
      "trace and region not recorded",
    );
    expect(
      screen.getByTestId("page-error-trace").querySelector("[data-recorded]"),
    ).toHaveAttribute("data-recorded", "false");
    expect(container.querySelector(".text-error-ink")).not.toBeNull();
    await expectNoAxe(container);
  });

  it("prints the trace id when the failure carried one", () => {
    view(<ErrorState what="Tools" code="503 x" trace="3141592653" />);
    expect(screen.getByTestId("page-error-trace")).toHaveTextContent(
      "trace 3141592653 · region not recorded",
    );
  });

  it("calls the boundary's retry, and refreshes the route without one", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    view(<ErrorState what="Tools" code="503 x" onRetry={onRetry} />);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    cleanup();

    view(<ErrorState what="Tools" code="503 x" />);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("opens an incident dialog that names the code and says nothing was sent", async () => {
    const user = userEvent.setup();
    view(<ErrorState what="Tools" code="503 tool_registry_unavailable" />);
    const open = screen.getByRole("button", { name: "Open an incident" });
    expect(open).toHaveAttribute("data-issue", "3847");
    expect(open).toBeEnabled();
    await user.click(open);
    const dialog = screen.getByTestId("page-state-incident-dialog");
    expect(dialog).toHaveTextContent("503 tool_registry_unavailable");
    expect(dialog).toHaveTextContent("Nothing was sent.");
  });

  it("can stand in for a whole page with an h1", () => {
    view(<ErrorState what="Fleet" code="503 x" heading="h1" />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Fleet could not be loaded" }),
    ).toBeVisible();
  });
});

describe("DeniedState", () => {
  const denied = (
    <DeniedState
      what="Billing"
      need="org.billing"
      org="acme"
      orgName="Acme"
      signedInAs="Mara Lin"
      role="org.member"
    />
  );

  it("names what the reader cannot see, the permission, and who can grant it", async () => {
    const { container } = view(denied);
    const state = screen.getByTestId("page-denied");
    expect(
      within(state).getByRole("heading", { name: "You cannot see Billing" }),
    ).toBeVisible();
    expect(state).toHaveTextContent(
      "Your roles on Acme do not include org.billing. An organization owner can grant it. The grant is a governed action and lands in the audit record with your name on it.",
    );
    const facts = state.querySelector("dl");
    expect(facts).toHaveTextContent("Signed in asMara Lin · org.member");
    expect(facts).toHaveTextContent("Neededorg.billing");
    expect(facts).toHaveTextContent(
      "Decided bypolicy not recorded · deny wins over every allow",
    );
    expect(container.querySelector(".text-warning")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Back to Fleet" })).toHaveAttribute(
      "href",
      "/",
    );
    await expectNoAxe(container);
  });

  it("opens a request dialog that links to the organization's owners", async () => {
    const user = userEvent.setup();
    view(denied);
    const request = screen.getByRole("button", { name: "Request access" });
    expect(request).toHaveAttribute("data-issue", "3846");
    await user.click(request);
    const dialog = screen.getByTestId("page-state-request-access-dialog");
    expect(dialog).toHaveTextContent("org.billing");
    expect(dialog).toHaveTextContent("Nothing was sent.");
    expect(
      within(dialog).getByRole("link", { name: "Open Organization" }),
    ).toHaveAttribute("href", "/acme");
  });
});

describe("PendingState and EmptyState", () => {
  it("names the waiting request", () => {
    view(<PendingState what="Billing" request="ar_1" />);
    expect(screen.getByTestId("page-pending")).toHaveTextContent(
      "Reading Billing parked for approval. The request is ar_1.",
    );
  });

  it("draws the caller's title, body and actions", () => {
    view(
      <EmptyState
        title="No tools yet"
        body="Register one to start."
        actions={<button type="button">Register</button>}
      />,
    );
    const state = screen.getByTestId("page-empty");
    expect(
      within(state).getByRole("heading", { name: "No tools yet" }),
    ).toBeVisible();
    expect(state).toHaveTextContent("Register one to start.");
    expect(within(state).getByRole("button", { name: "Register" })).toBeVisible();
  });
});

describe("NotFoundState", () => {
  it.each([
    [{ scope: "app" } as const, "This address does not match a page you can open.", "Go to Oxagen", "/"],
    [
      { scope: "organization", org: "acme" } as const,
      "This address does not match a page in this organization.",
      "Open Organization",
      "/acme",
    ],
    [
      { scope: "workspace", org: "acme", ws: "core" } as const,
      "This address does not match a page in this workspace.",
      "Back to Fleet",
      "/acme/core",
    ],
  ])("leads back to the nearest page that exists (%o)", async (scope, body, label, href) => {
    const { container } = view(<NotFoundState {...scope} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
    expect(screen.getByTestId("page-not-found")).toHaveTextContent(body);
    expect(screen.getByRole("link", { name: label })).toHaveAttribute(
      "href",
      href,
    );
    await expectNoAxe(container);
  });
});
