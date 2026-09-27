// @vitest-environment jsdom
// The steering repo health banner over fake repairs (#4518): each unhealthy
// state and its heading, the table of prescribed settings that differ on
// GitHub and GitLab, Repair for an owner or admin, Re-authorize for a lost
// grant, and the reverting steering PR for an unmerged commit. The platform
// does not register `repair_steering_repo` yet, so the refusal a deployment
// answers today is covered too. The layout's wrapper draws nothing while the
// repo is healthy, unread, or not backed by a capability.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { settingsDifference, steeringRepoView } from "./steering-repo.builders";
import type { SteeringRepoRead } from "./types";

const actions = vi.hoisted(() => ({
  retrySteeringRepoProvision: vi.fn(),
  repairSteeringRepo: vi.fn(),
}));
vi.mock("./actions", () => actions);

const read = vi.hoisted(() => ({ readSteeringRepo: vi.fn() }));
vi.mock("./read", () => read);

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: nav.refresh }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { SteeringRepoHealthBannerView } = await import("./health-banner-view");
const { SteeringRepoHealthBanner } = await import("./health-banner");

const RETURN_TO = routes.repositories("acme", "core-platform");

type BannerProps = ComponentProps<typeof SteeringRepoHealthBannerView>;

function banner(overrides: Partial<BannerProps> = {}) {
  render(
    <IntlProvider>
      <SteeringRepoHealthBannerView
        org="acme"
        ws="core-platform"
        provider="github"
        health="drifted"
        differences={[settingsDifference()]}
        canAct
        returnTo={RETURN_TO}
        {...overrides}
      />
    </IntlProvider>,
  );
  return screen.getByTestId("steering-repo-health-banner");
}

/** The table row that lists `setting`. */
function row(setting: string): HTMLElement {
  const found = screen
    .getByTestId("steering-repo-differences")
    .querySelector<HTMLElement>(`tr[data-setting="${setting}"]`);
  if (found === null) throw new Error(`No row lists ${setting}`);
  return found;
}

/** The text of each `<code>` cell in the row that lists `setting`. */
function codeCells(setting: string) {
  return [...row(setting).querySelectorAll("td code")].map(
    (code) => code.textContent,
  );
}

function reauthorizeHref(link: HTMLElement) {
  return new URL(link.getAttribute("href") ?? "", "https://app.oxagen.sh");
}

beforeEach(() => {
  actions.retrySteeringRepoProvision.mockReset();
  actions.repairSteeringRepo.mockReset();
  read.readSteeringRepo.mockReset();
  nav.refresh.mockReset();
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the steering repo health banner", () => {
  it("names settings drift and lists each setting that differs in code", () => {
    const root = banner({
      differences: [
        settingsDifference(),
        settingsDifference({
          setting: "branch_protection.required_approvals",
          expected: "1",
          actual: "0",
        }),
      ],
    });
    expect(root).toHaveAttribute("data-health", "drifted");
    expect(root).toHaveAttribute("data-provider", "github");
    expect(
      within(root).getByRole("heading", { level: 2, name: "Settings drift" }),
    ).toBeInTheDocument();
    expect(root).toHaveTextContent(
      "Oxagen merges and publishes nothing until you repair the repository.",
    );
    const table = within(root).getByRole("table", {
      name: "Settings that differ",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Setting", "Prescribed", "Current", "Changed by"]);
    expect(codeCells("rulesets.oxagen_merges")).toEqual([
      "rulesets.oxagen_merges",
      "active",
      "disabled",
    ]);
    expect(codeCells("branch_protection.required_approvals")).toEqual([
      "branch_protection.required_approvals",
      "1",
      "0",
    ]);
  });

  it("names who changed each setting and when, as far as the host reported", () => {
    banner({
      differences: [
        settingsDifference({ setting: "both" }),
        settingsDifference({ setting: "person", changedAt: null }),
        settingsDifference({ setting: "time", changedBy: null }),
        settingsDifference({
          setting: "neither",
          changedBy: null,
          changedAt: null,
        }),
      ],
    });
    expect(row("both")).toHaveTextContent(/jordan-lee at Sep 26, 2026/);
    expect(row("person").lastElementChild).toHaveTextContent(/^jordan-lee$/);
    expect(row("time").lastElementChild).toHaveTextContent(/^Sep 26, 2026/);
    expect(row("neither").lastElementChild).toHaveTextContent(/^Unknown$/);
  });

  it("lists a GitLab project's approval setting in code with an unknown changer", () => {
    const root = banner({
      provider: "gitlab",
      differences: [
        settingsDifference({
          setting: "merge_requests.reset_approvals_on_push",
          expected: "true",
          actual: "false",
          changedBy: null,
          changedAt: null,
        }),
      ],
    });
    expect(root).toHaveAttribute("data-provider", "gitlab");
    expect(codeCells("merge_requests.reset_approvals_on_push")).toEqual([
      "merge_requests.reset_approvals_on_push",
      "true",
      "false",
    ]);
    expect(
      row("merge_requests.reset_approvals_on_push").lastElementChild,
    ).toHaveTextContent("Unknown");
  });

  it("repairs the workspace's steering repo for an owner or admin and re-reads the page", async () => {
    actions.repairSteeringRepo.mockResolvedValue({
      ok: true,
      value: { health: "healthy" },
    });
    banner();
    await userEvent.click(screen.getByTestId("steering-repo-repair"));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
    expect(actions.repairSteeringRepo).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    expect(screen.queryByTestId("steering-repo-repair-failure")).toBeNull();
  });

  it("shows the pending label and repairs once however many times a person clicks", async () => {
    let answer: (value: unknown) => void = () => {};
    actions.repairSteeringRepo.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    banner();
    const repair = screen.getByTestId("steering-repo-repair");
    await userEvent.click(repair);
    expect(repair).toHaveTextContent("Repairing");
    expect(repair).toBeDisabled();
    await userEvent.click(repair);
    expect(actions.repairSteeringRepo).toHaveBeenCalledTimes(1);
    answer({ ok: true, value: { health: "healthy" } });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
  });

  it("shows a member the drift and no Repair (negative)", () => {
    banner({ canAct: false });
    expect(screen.getByTestId("steering-repo-differences")).toBeInTheDocument();
    expect(screen.queryByTestId("steering-repo-repair")).toBeNull();
  });

  it("names the capability a deployment has not registered, and re-reads nothing (negative)", async () => {
    actions.repairSteeringRepo.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "tool_not_registered",
    });
    banner();
    await userEvent.click(screen.getByTestId("steering-repo-repair"));
    expect(
      await screen.findByTestId("steering-repo-repair-failure"),
    ).toHaveTextContent(
      "This deployment does not run repair_steering_repo yet, so Oxagen changed nothing.",
    );
    expect(nav.refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId("steering-repo-repair")).toBeEnabled();
  });

  it("says the repair went unanswered when the call threw (negative)", async () => {
    actions.repairSteeringRepo.mockRejectedValue(new Error("network down"));
    banner();
    await userEvent.click(screen.getByTestId("steering-repo-repair"));
    expect(
      await screen.findByTestId("steering-repo-repair-failure"),
    ).toHaveTextContent("action_failed");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("offers Re-authorize on GitHub for a lost grant, through the API route that returns to the page", () => {
    const root = banner({ health: "disconnected", differences: [] });
    expect(
      within(root).getByRole("heading", { name: "Repository disconnected" }),
    ).toBeInTheDocument();
    const link = screen.getByTestId("steering-repo-banner-reauthorize");
    expect(link).toHaveTextContent("Re-authorize");
    expect(link).toHaveAttribute("data-provider", "github");
    const href = reauthorizeHref(link);
    expect(href.pathname).toBe("/api/v1/acme/connections/steering/github");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      app: "steering",
      mode: "authorize",
      return_to: RETURN_TO,
    });
    expect(screen.queryByTestId("steering-repo-repair")).toBeNull();
    expect(screen.queryByTestId("steering-repo-differences")).toBeNull();
  });

  it("sends a GitLab owner to the connect step to paste the group token again", () => {
    banner({ provider: "gitlab", health: "disconnected", differences: [] });
    const link = screen.getByTestId("steering-repo-banner-reauthorize");
    expect(link).toHaveAttribute("data-provider", "gitlab");
    expect(link).toHaveAttribute("href", routes.welcomeConnect("acme"));
  });

  it("shows a member a lost grant and no Re-authorize (negative)", () => {
    banner({ health: "disconnected", differences: [], canAct: false });
    expect(
      screen.getByRole("heading", { name: "Repository disconnected" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("steering-repo-banner-reauthorize")).toBeNull();
  });

  it("tells an owner or admin that Oxagen opened a steering PR to revert an unmerged commit", () => {
    const root = banner({ health: "diverged", differences: [] });
    expect(root).toHaveAttribute("data-health", "diverged");
    expect(
      within(root).getByRole("heading", { name: "Unmerged commit on main" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("steering-repo-reverting")).toHaveTextContent(
      "Oxagen opened a steering PR that reverts main.",
    );
    expect(screen.queryByTestId("steering-repo-differences")).toBeNull();
    expect(screen.queryByTestId("steering-repo-repair")).toBeNull();
    expect(screen.queryByTestId("steering-repo-banner-reauthorize")).toBeNull();
  });

  it("shows a member an unmerged commit without the steering PR note (negative)", () => {
    banner({ health: "diverged", differences: [], canAct: false });
    expect(screen.queryByTestId("steering-repo-reverting")).toBeNull();
  });
});

describe("the workspace layout's health banner", () => {
  function ctx(orgRole: "owner" | "admin" | "member" | "viewer" = "owner") {
    return unsafeMint(WsCtx, {
      userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      orgId: "7a000000-0000-4000-8000-0000000000a1",
      orgSlug: "acme",
      orgName: "Acme Robotics",
      orgRole,
      workspaceId: "7b000000-0000-4000-8000-000000000001",
      wsSlug: "core-platform",
      wsName: "Core platform",
      wsRole: "member",
    });
  }

  async function layoutBanner(
    answer: SteeringRepoRead,
    orgRole?: Parameters<typeof ctx>[0],
  ) {
    read.readSteeringRepo.mockResolvedValue(answer);
    const viewer = ctx(orgRole);
    const element = await SteeringRepoHealthBanner({ ctx: viewer });
    expect(read.readSteeringRepo).toHaveBeenCalledWith(viewer);
    if (element !== null) render(<IntlProvider>{element}</IntlProvider>);
    return element;
  }

  it("draws nothing while no capability backs the read (negative)", async () => {
    expect(
      await layoutBanner({
        kind: "not_backed",
        capability: "get_steering_repo",
      }),
    ).toBeNull();
  });

  it("draws nothing while the repo is healthy (negative)", async () => {
    expect(
      await layoutBanner({ kind: "ok", view: steeringRepoView() }),
    ).toBeNull();
  });

  it("draws nothing before the first health read (negative)", async () => {
    expect(
      await layoutBanner({
        kind: "ok",
        view: steeringRepoView({ status: "provisioning", health: null }),
      }),
    ).toBeNull();
  });

  const DRIFTED: SteeringRepoRead = {
    kind: "ok",
    view: steeringRepoView({
      health: "drifted",
      differences: [settingsDifference()],
    }),
  };

  it.each(["owner", "admin"] as const)(
    "offers an org %s Repair",
    async (orgRole) => {
      await layoutBanner(DRIFTED, orgRole);
      expect(
        screen.getByTestId("steering-repo-health-banner"),
      ).toHaveAttribute("data-health", "drifted");
      expect(screen.getByTestId("steering-repo-repair")).toBeInTheDocument();
    },
  );

  it.each(["member", "viewer"] as const)(
    "shows an org %s the drift and no Repair (negative)",
    async (orgRole) => {
      await layoutBanner(DRIFTED, orgRole);
      expect(
        screen.getByTestId("steering-repo-differences"),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("steering-repo-repair")).toBeNull();
    },
  );

  it("returns a person who re-authorizes to the repositories page", async () => {
    await layoutBanner({
      kind: "ok",
      view: steeringRepoView({ health: "disconnected" }),
    });
    const href = reauthorizeHref(
      screen.getByTestId("steering-repo-banner-reauthorize"),
    );
    expect(href.searchParams.get("return_to")).toBe(RETURN_TO);
  });
});
