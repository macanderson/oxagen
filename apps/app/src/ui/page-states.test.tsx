// @vitest-environment jsdom
// The three not-loaded states every page shares (audit-prompt check 22):
// the skeleton's shape (four tiles, a panel of seven rows), the error's copy
// with the code the read answered, Try again re-reading the page, and the
// denial naming the permission with who asked, what was needed and what
// decided. Request access and Open an incident have no write yet, so each is
// disabled and says why rather than doing nothing.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { pathOf } from "@/shared/safe-path";
import { PageDenied, PageError, PageSkeleton, RouteError } from "./page-states";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
    refresh.mockReset();
  }
});

describe("PageSkeleton", () => {
  it("draws four tile blocks and a panel of seven rows, announced as loading", () => {
    render(
      <IntlProvider>
        <PageSkeleton />
      </IntlProvider>,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading this page");
    expect(status.querySelectorAll("[data-skeleton-tile]")).toHaveLength(4);
    expect(status.querySelectorAll("[data-skeleton-row]")).toHaveLength(7);
    // No figure is drawn while the reads are in flight.
    expect(status.textContent).not.toMatch(/\d/);
  });

  it("takes the page's own label", () => {
    render(
      <IntlProvider>
        <PageSkeleton label="Loading Fleet" />
      </IntlProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading Fleet");
  });
});

describe("PageError", () => {
  function renderError(trace: {
    at: string;
    id?: string | null;
    region?: string | null;
  }) {
    render(
      <IntlProvider>
        <PageError
          title="Fleet could not be loaded"
          status={503}
          code="run_index_unavailable"
          trace={trace}
        />
      </IntlProvider>,
    );
    return screen.getByTestId("page-error");
  }

  it("says what the control plane answered, verbatim, with the trace line", () => {
    const state = renderError({
      id: "01K5RSXQ7F2E",
      region: "us-east-1",
      at: "2026-09-11 09:16:04Z",
    });
    expect(
      within(state).getByRole("heading", { name: "Fleet could not be loaded" }),
    ).toBeInTheDocument();
    expect(state).toHaveTextContent(
      "The control plane answered 503 run_index_unavailable. Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
    );
    expect(within(state).getByText("503 run_index_unavailable").tagName).toBe(
      "CODE",
    );
    expect(within(state).getByTestId("page-error-trace")).toHaveTextContent(
      "trace 01K5RSXQ7F2E · us-east-1 · 2026-09-11 09:16:04Z",
    );
  });

  it("draws only the parts of the trace the read recorded (negative)", () => {
    const state = renderError({ at: "2026-09-11 09:16:04Z" });
    expect(within(state).getByTestId("page-error-trace").textContent).toBe(
      "2026-09-11 09:16:04Z",
    );
  });

  it("re-reads the page on Try again", async () => {
    const user = userEvent.setup();
    const state = renderError({ at: "now" });
    await user.click(within(state).getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("disables Open an incident and says why (negative)", () => {
    const state = renderError({ at: "now" });
    const incident = within(state).getByRole("button", {
      name: "Open an incident",
    });
    expect(incident).toHaveAttribute("aria-disabled", "true");
    expect(incident).toHaveAccessibleDescription(
      /cannot open an incident from this page yet/,
    );
    expect(incident).toHaveAttribute("data-gap");
  });
});

describe("RouteError", () => {
  function renderBoundary(digest?: string) {
    const reset = vi.fn();
    const error = Object.assign(new Error("boom"), digest ? { digest } : {});
    render(
      <IntlProvider>
        <RouteError error={error} reset={reset} />
      </IntlProvider>,
    );
    return reset;
  }

  it("draws the error state with the server's digest as the trace id and the instant it caught the failure", () => {
    renderBoundary("2731905432");
    expect(
      screen.getByRole("heading", { name: "This page could not be loaded" }),
    ).toBeInTheDocument();
    expect(screen.getByText("500 internal_error")).toBeInTheDocument();
    expect(screen.getByTestId("page-error-trace").textContent).toMatch(
      /^trace 2731905432 · \d{2}:\d{2}:\d{2}Z$/,
    );
  });

  it("prints no trace id when the failure carries no digest (negative)", () => {
    renderBoundary();
    expect(screen.getByTestId("page-error-trace").textContent).toMatch(
      /^\d{2}:\d{2}:\d{2}Z$/,
    );
  });

  it("re-requests the route and clears the boundary on Try again", async () => {
    const reset = renderBoundary("1");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("PageDenied", () => {
  function renderDenied(decidedBy: string | null) {
    render(
      <IntlProvider>
        <PageDenied
          title="You cannot see this workspace"
          orgName="Anderson Intelligence Corp."
          permission="workspace.read on core-platform"
          signedIn={{
            name: "Marcus Bell",
            role: "workspace.owner",
            scope: "core-platform",
          }}
          decidedBy={decidedBy}
          back={pathOf("a-intel", "core-platform")}
        />
      </IntlProvider>,
    );
    return screen.getByTestId("page-denied");
  }

  it("names the permission, who asked, what was needed and what decided", () => {
    const state = renderDenied("pol_v41");
    expect(
      within(state).getByRole("heading", {
        name: "You cannot see this workspace",
      }),
    ).toBeInTheDocument();
    expect(state).toHaveTextContent(
      "Your roles on Anderson Intelligence Corp. do not include workspace.read on core-platform. An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
    );
    const facts = state.querySelector("dl");
    expect(facts).toHaveTextContent(
      "Signed in asMarcus Bell · workspace.owner · core-platform",
    );
    expect(facts).toHaveTextContent("Neededworkspace.read on core-platform");
    expect(facts).toHaveTextContent(
      "Decided bypol_v41 · deny wins over every allow",
    );
    expect(
      within(state).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/a-intel/core-platform");
  });

  it("disables Request access and says why, since no write asks for a role (negative)", () => {
    const state = renderDenied("pol_v41");
    const request = within(state).getByRole("button", {
      name: "Request access",
    });
    expect(request).toHaveAttribute("aria-disabled", "true");
    expect(request).toHaveAccessibleDescription(
      /An organization owner grants one on the Organization page/,
    );
  });

  it("says the refusal recorded no policy rather than naming one (negative)", () => {
    const state = renderDenied(null);
    expect(
      within(state).getByTestId("page-denied-decided-by"),
    ).toHaveTextContent("The refusal does not record which policy decided it.");
    expect(state).not.toHaveTextContent("pol_");
  });
});
