// @vitest-environment jsdom
// The gate shell and its two not-loaded bodies: the rail as each step draws it
// (done steps open their page, the current one is announced, later ones are
// disabled), the top bar and caption, the skeleton, and the denied state with
// its request-access dialog, which says that nothing is sent.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { GateShell } = await import("./gate-shell");
const { GateDenied, GateSkeleton } = await import("./gate-states");

const CAPTION =
  "The operator console does not open until an agent has talked to Oxagen. That first frame is also the installer’s smoke test, so there is one path, not two.";

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function rail() {
  const nav = screen.getByRole("navigation", { name: "Onboarding" });
  return [...nav.querySelectorAll("li")].map((li) => ({
    step: li.dataset.step,
    state: li.dataset.state,
    control: li.firstElementChild,
  }));
}

describe("GateShell", () => {
  it("on step 1: the email, Cancel, the rail with step 1 current and 2 and 3 disabled, and the caption", () => {
    render(
      <IntlProvider>
        <GateShell
          step="organization"
          email="marcus@a-intel.example"
          cancel={routes.root()}
        >
          <p>body</p>
        </GateShell>
      </IntlProvider>,
    );
    expect(screen.getByTestId("gate-email")).toHaveTextContent(
      "marcus@a-intel.example",
    );
    expect(screen.getByTestId("gate-cancel")).toHaveAttribute("href", "/");
    const steps = rail();
    expect(steps.map((s) => [s.step, s.state])).toEqual([
      ["organization", "current"],
      ["wrap", "todo"],
      ["run", "todo"],
    ]);
    expect(steps[0]?.control).toHaveAttribute("aria-current", "step");
    expect(steps[0]?.control).toHaveTextContent("Name the organization");
    expect(steps[1]?.control).toBeDisabled();
    expect(steps[2]?.control).toBeDisabled();
    expect(screen.getByText(CAPTION)).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("on step 3: steps 1 and 2 are done and open their pages, step 3 is current", () => {
    const wrap = routes.welcome("acme", "core", "wrap", { agent: "agt_1" });
    render(
      <IntlProvider>
        <GateShell
          step="run"
          email={null}
          cancel={routes.fleet("acme", "core")}
          back={{ organization: routes.newOrganization(), wrap }}
        >
          <p>body</p>
        </GateShell>
      </IntlProvider>,
    );
    const steps = rail();
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "current"]);
    expect(steps[0]?.control).toHaveAttribute("href", "/new-organization");
    expect(steps[1]?.control).toHaveAttribute("href", wrap);
    expect(steps[1]?.control).toHaveTextContent("✓Wrap an agentdone");
    expect(steps[2]?.control).toHaveAttribute("aria-current", "step");
    expect(screen.queryByTestId("gate-email")).toBeNull();
    expect(screen.getByTestId("gate-cancel")).toHaveAttribute(
      "href",
      "/acme/core",
    );
  });

  it("as a Suspense fallback beside the streamed step, leaves main#main to the step alone", () => {
    // While a step streams in, the document holds the fallback and the step
    // together. Both claimed main#main until 2026-09-24, and the page-load
    // oracle's strict locator failed on the three gate pages.
    const { container } = render(
      <IntlProvider>
        <GateShell step="wrap" email={null} cancel={routes.root()} pending>
          <p>loading</p>
        </GateShell>
        <GateShell
          step="wrap"
          email="marcus@a-intel.example"
          cancel={routes.root()}
        >
          <p>step</p>
        </GateShell>
      </IntlProvider>,
    );
    const mains = container.querySelectorAll("main#main");
    expect(mains).toHaveLength(1);
    expect(mains[0]).toHaveTextContent("step");
    expect(
      screen.getByText("loading").closest("[aria-busy='true']"),
    ).not.toBeNull();
  });
});

describe("GateSkeleton", () => {
  it("is four tile blocks and a panel of seven rows, busy and with no data", () => {
    render(
      <IntlProvider>
        <GateSkeleton />
      </IntlProvider>,
    );
    const skeleton = screen.getByTestId("page-state-loading");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton.querySelectorAll("[data-skeleton-tile]")).toHaveLength(4);
    expect(skeleton.querySelectorAll("[data-skeleton-row]")).toHaveLength(7);
    // Every bone is the design's shimmer: the tiles, the title bar, the rows.
    expect(skeleton.querySelectorAll(".skeleton")).toHaveLength(12);
    expect(skeleton.querySelector(".animate-pulse")).toBeNull();
    expect(skeleton).toHaveTextContent("");
  });
});

describe("GateDenied", () => {
  it("names the permission, who is signed in and what decided, and opens request-access saying nothing is sent", async () => {
    render(
      <IntlProvider>
        <GateDenied
          org="Anderson Intelligence Corp."
          permission="enrollment.create on core-platform"
          signedIn="Marcus Bell · workspace.owner · core-platform"
          back={routes.fleet("acme", "core")}
        />
      </IntlProvider>,
    );
    const denied = screen.getByTestId("page-state-denied");
    expect(
      within(denied).getByRole("heading", {
        name: "You cannot see onboarding",
      }),
    ).toBeInTheDocument();
    expect(denied).toHaveTextContent(
      "Your roles on Anderson Intelligence Corp. do not include enrollment.create on core-platform. An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core");
    const facts = [...denied.querySelectorAll("dt, dd")].map(
      (el) => el.textContent,
    );
    expect(facts).toEqual([
      "Signed in as",
      "Marcus Bell · workspace.owner · core-platform",
      "Needed",
      "enrollment.create on core-platform",
      "Decided by",
      "the organization role check · deny wins over every allow",
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: "Request access" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Request access",
    });
    expect(
      within(dialog).getByTestId("request-access-not-backed"),
    ).toHaveTextContent("Access requests are not recorded yet");
  });

  it("before an organization exists, names the account's missing permission", () => {
    render(
      <IntlProvider>
        <GateDenied
          org={null}
          permission="org.create for marcus@a-intel.example"
          signedIn="marcus@a-intel.example"
          back={routes.root()}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("page-state-denied")).toHaveTextContent(
      "Your account does not hold org.create for marcus@a-intel.example.",
    );
  });
});
