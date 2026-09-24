// @vitest-environment jsdom
// The not-loaded states every page shares (audit-prompt check 22):
// the skeleton's shape (four tiles, a panel of seven rows), the error's copy
// with the code the read answered, Try again re-reading the page, and the
// denial naming the permission with who asked, what was needed and what
// decided. Request access and Open an incident have no write yet, so each is
// disabled and says why rather than doing nothing. An address nothing answers
// names the path and goes back to Fleet or to the Organization page.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { pathOf } from "@/shared/safe-path";
import {
  PageDenied,
  PageError,
  PageNotFound,
  PageSkeleton,
  RouteError,
  RoutePageNameContext,
} from "./page-states";

const { refresh, route } = vi.hoisted(() => {
  const params: Record<string, string> = { org: "acme", ws: "core-platform" };
  return {
    refresh: vi.fn(),
    route: { pathname: "/acme/core-platform", params },
  };
});
vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useParams: () => route.params,
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
    route.pathname = "/acme/core-platform";
    route.params = { org: "acme", ws: "core-platform" };
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

  it("draws every bone with the design's shimmer, at the design's sizes", () => {
    render(
      <IntlProvider>
        <PageSkeleton />
      </IntlProvider>,
    );
    const status = screen.getByRole("status");
    const bones = [...status.querySelectorAll(".skeleton")];
    // Four tiles, the panel's title bar and seven rows.
    expect(bones).toHaveLength(12);
    for (const tile of status.querySelectorAll("[data-skeleton-tile]")) {
      expect(tile).toHaveClass("h-16", "rounded-[11px]");
      // `.sk.b` has no border: the shimmer is the whole tile.
      expect(tile.className).not.toMatch(/\bborder\b/);
    }
    for (const row of status.querySelectorAll("[data-skeleton-row]")) {
      expect(row).toHaveClass("h-[38px]", "rounded-[9px]");
    }
    const bar = bones.find((bone) => bone.classList.contains("h-[22px]"));
    expect(bar).toHaveClass("w-[180px]", "rounded-[7px]");
    // No pulse: the shimmer is the one loading motion.
    expect(status.querySelector(".animate-pulse")).toBeNull();
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
    const error: Error & { digest?: string } = new Error("boom");
    if (digest) error.digest = digest;
    render(
      <IntlProvider>
        <RouteError error={error} reset={reset} />
      </IntlProvider>,
    );
    return reset;
  }

  it("draws the error state with the server's digest as the trace id and the instant it caught the failure", async () => {
    renderBoundary("2731905432");
    expect(
      screen.getByRole("heading", { name: "This page could not be loaded" }),
    ).toBeInTheDocument();
    expect(screen.getByText("500 internal_error")).toBeInTheDocument();
    // The instant is read on the task after mount, so the trace fills in then.
    await waitFor(() => {
      expect(screen.getByTestId("page-error-trace").textContent).toMatch(
        /^trace 2731905432 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/,
      );
    });
    // The skip link's target is on the boundary's own <main>.
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("names the page the shell resolved from the path, as the mock's title does", () => {
    render(
      <IntlProvider>
        <RoutePageNameContext value={() => "Fleet"}>
          <RouteError error={new Error("boom")} reset={vi.fn()} />
        </RoutePageNameContext>
      </IntlProvider>,
    );
    expect(
      screen.getByRole("heading", { name: "Fleet could not be loaded" }),
    ).toBeInTheDocument();
  });

  it("prints no trace id when the failure carries no digest (negative)", async () => {
    renderBoundary();
    await waitFor(() => {
      expect(screen.getByTestId("page-error-trace").textContent).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/,
      );
    });
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
      /Oxagen cannot send a request for a role yet\./,
    );
  });

  it("says the refusal recorded no policy rather than naming one (negative)", () => {
    const state = renderDenied(null);
    expect(
      within(state).getByTestId("page-denied-decided-by"),
    ).toHaveTextContent("policy not recorded · deny wins over every allow");
    expect(state).not.toHaveTextContent("pol_");
  });

  it("draws the lock in the denied tone, in the design's state shape", () => {
    const state = renderDenied("pol_v41");
    const icon = state.querySelector("[data-state-icon]");
    expect(icon).toHaveAttribute("data-state-icon", "denied");
    expect(icon).toHaveClass("border-warning/40", "text-warning");
    expect(icon).not.toHaveClass("border-border");
    expect(state).toHaveClass("grid", "place-items-center", "py-[60px]");
  });
});

describe("PageNotFound", () => {
  it("names the path and the workspace, with one way back to Fleet", () => {
    route.pathname = "/acme/core-platform/runs/run_missing";
    render(
      <IntlProvider>
        <PageNotFound scope="workspace" />
      </IntlProvider>,
    );
    const state = screen.getByTestId("page-not-found");
    expect(
      within(state).getByRole("heading", { name: "No page has this address" }),
    ).toBeInTheDocument();
    expect(state).toHaveTextContent(
      "Nothing in workspace core-platform is at /acme/core-platform/runs/run_missing. The link may be mistyped, or the run, agent or record it names may not exist.",
    );
    const back = within(state).getByRole("link");
    expect(back).toHaveAccessibleName("Back to Fleet");
    expect(back).toHaveAttribute("href", "/acme/core-platform");
    // The empty glyph in the neutral tone, and the skip link's target.
    expect(state.querySelector("[data-state-icon]")).toHaveAttribute(
      "data-state-icon",
      "neutral",
    );
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("above a workspace, names the organization and goes back to the Organization page", () => {
    route.pathname = "/acme/billing/nothing";
    route.params = { org: "acme" };
    render(
      <IntlProvider>
        <PageNotFound scope="organization" />
      </IntlProvider>,
    );
    const state = screen.getByTestId("page-not-found");
    expect(state).toHaveTextContent(
      "Nothing in organization acme is at /acme/billing/nothing.",
    );
    const back = within(state).getByRole("link", {
      name: "Back to Organization",
    });
    expect(back).toHaveAttribute("href", "/acme");
    expect(
      within(state).queryByRole("link", { name: "Back to Fleet" }),
    ).toBeNull();
  });

  it("goes back to the Organization page when a workspace boundary has no workspace param (negative)", () => {
    route.params = { org: "acme" };
    render(
      <IntlProvider>
        <PageNotFound scope="workspace" />
      </IntlProvider>,
    );
    expect(
      screen.getByRole("link", { name: "Back to Organization" }),
    ).toHaveAttribute("href", "/acme");
  });
});
