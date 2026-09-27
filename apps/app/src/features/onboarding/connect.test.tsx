// @vitest-environment jsdom
// Connect a code host, onboarding step 2: who may see it (an org Owner or
// Admin, checked before anything renders), the two GitHub apps and where each
// install returns, the GitLab form, the continue to the first workspace, and
// the line a GitHub install leaves behind. Axe runs after every test.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@/features/steering-repo", () => ({
  steeringGithubHref: (
    org: string,
    leg: { app: string; mode: string },
    returnTo: string,
  ) =>
    `/api/v1/${org}/connections/steering/github?app=${leg.app}&mode=${leg.mode}&return_to=${returnTo}`,
  steeringGitlabPath: (org: string) =>
    `/api/v1/${org}/connections/steering/gitlab`,
}));
vi.mock("@/server/session", () => ({
  getSession: vi.fn(),
  getAuthUser: () =>
    Promise.resolve({ name: "Marcus Bell", email: "marcus@acme.example" }),
}));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { WelcomeConnect } = await import("./connect");

function ctxAs(orgRole: "owner" | "admin" | "member") {
  return unsafeMint(OrgCtx, {
    userId: "usr_marcusbell",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
  });
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Connect a code host", () => {
  it.each(["owner", "admin"] as const)(
    "shows an %s both GitHub apps, the GitLab form and the continue, with step 2 current",
    async (role) => {
      const element = await WelcomeConnect({ ctx: ctxAs(role), result: null });
      render(<IntlProvider>{element}</IntlProvider>);
      expect(screen.getByText("Step 2 of 5")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { level: 1, name: "Connect a code host" }),
      ).toBeInTheDocument();
      const rail = screen.getByTestId("gate-rail");
      expect(
        [...rail.querySelectorAll<HTMLElement>("li")].map(
          (li) => li.dataset.state,
        ),
      ).toEqual(["done", "current", "todo", "todo", "todo"]);
      expect(screen.getByTestId("gate-email")).toHaveTextContent(
        "marcus@acme.example",
      );

      const github = screen.getByTestId("connect-github");
      expect(
        within(github).getByRole("heading", { name: "GitHub" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("connect-github-steering")).toHaveTextContent(
        "Oxagen Steering",
      );
      expect(
        screen.getByTestId("connect-github-steering-install"),
      ).toHaveAttribute(
        "href",
        "/api/v1/acme/connections/steering/github?app=steering&mode=install&return_to=/welcome/acme/new-workspace",
      );
      expect(
        screen.getByRole("link", { name: "Install Oxagen Steering" }),
      ).toBe(screen.getByTestId("connect-github-steering-install"));
      expect(
        screen.getByTestId("connect-github-oxagen-install"),
      ).toHaveAttribute(
        "href",
        "/api/v1/acme/connections/steering/github?app=oxagen&mode=install&return_to=/welcome/acme/new-workspace/connect",
      );

      const gitlab = screen.getByTestId("connect-gitlab");
      expect(
        within(gitlab).getByRole("heading", { name: "GitLab" }),
      ).toBeInTheDocument();
      expect(within(gitlab).getByTestId("gitlab-connect")).toBeInTheDocument();
      expect(within(gitlab).getByLabelText("Group path")).toBeInTheDocument();

      expect(screen.getByTestId("connect-continue")).toHaveAttribute(
        "href",
        "/welcome/acme/new-workspace",
      );
      expect(screen.queryByTestId("steering-connected")).toBeNull();
      expect(screen.queryByTestId("steering-error")).toBeNull();
    },
  );

  it("shows a member the denied state and no install links (negative)", async () => {
    const element = await WelcomeConnect({
      ctx: ctxAs("member"),
      result: null,
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(screen.getByTestId("page-state-denied")).toHaveTextContent(
      "connection.create on acme",
    );
    expect(screen.queryByTestId("connect-github")).toBeNull();
    expect(screen.queryByTestId("gitlab-connect")).toBeNull();
    expect(screen.queryByTestId("connect-continue")).toBeNull();
  });

  it("says GitHub is connected when the install returned connected", async () => {
    const element = await WelcomeConnect({
      ctx: ctxAs("owner"),
      result: { kind: "connected" },
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(screen.getByTestId("steering-connected")).toHaveTextContent(
      "GitHub is connected.",
    );
  });

  it("names the reason when the install returned an error (negative)", async () => {
    const element = await WelcomeConnect({
      ctx: ctxAs("owner"),
      result: { kind: "error", code: "installation_denied" },
    });
    render(<IntlProvider>{element}</IntlProvider>);
    expect(screen.getByTestId("steering-error")).toHaveTextContent(
      "GitHub did not connect (installation_denied). Install the app again.",
    );
    expect(screen.getByTestId("connect-continue")).toBeInTheDocument();
  });
});
