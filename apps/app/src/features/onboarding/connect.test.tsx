// @vitest-environment jsdom
// Connect a code host, onboarding step 2: who may see it (an org Owner or
// Admin, checked before anything renders), the one GitHub app with Install
// before Authorize and where both return, the GitLab form, the continue to the
// first workspace, and the line a GitHub connect leaves behind. The hrefs come
// from the real steeringGithubHref, so the query each link sends is the one
// the API reads. Axe runs after every test.
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
// The lane's barrel pulls in server reads the step never calls. The two href
// builders come through unchanged from the lane's own module.
vi.mock("@/features/steering-repo", async () => {
  const { steeringGithubHref, steeringGitlabPath } =
    await vi.importActual<typeof import("../steering-repo/hrefs")>(
      "../steering-repo/hrefs",
    );
  return { steeringGithubHref, steeringGitlabPath };
});
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

/** A link's href, parsed, so a test reads its path and query apart. */
function hrefOf(link: HTMLElement) {
  return new URL(link.getAttribute("href") ?? "", "https://app.oxagen.sh");
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
    "shows an %s the Oxagen app, the GitLab form and the continue, with step 2 current",
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
      const app = within(github).getByTestId("connect-github-app");
      expect(
        within(app).getByRole("heading", { level: 3, name: "Oxagen" }),
      ).toBeInTheDocument();

      const install = within(app).getByTestId("connect-github-install");
      expect(within(app).getByRole("link", { name: "Install Oxagen" })).toBe(
        install,
      );
      expect(hrefOf(install).pathname).toBe(
        "/api/v1/acme/connections/steering/github",
      );
      expect(Object.fromEntries(hrefOf(install).searchParams)).toEqual({
        mode: "install",
        return_to: "/welcome/acme/new-workspace",
      });

      const authorize = within(app).getByTestId("connect-github-authorize");
      expect(within(app).getByRole("link", { name: "Authorize Oxagen" })).toBe(
        authorize,
      );
      expect(hrefOf(authorize).pathname).toBe(
        "/api/v1/acme/connections/steering/github",
      );
      expect(Object.fromEntries(hrefOf(authorize).searchParams)).toEqual({
        mode: "authorize",
        return_to: "/welcome/acme/new-workspace",
      });

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

  it("puts Install before Authorize, and neither link names an app", async () => {
    const element = await WelcomeConnect({ ctx: ctxAs("owner"), result: null });
    render(<IntlProvider>{element}</IntlProvider>);
    const app = screen.getByTestId("connect-github-app");
    const links = within(app).getAllByRole("link");
    expect(links.map((link) => link.dataset.testid)).toEqual([
      "connect-github-install",
      "connect-github-authorize",
    ]);
    for (const link of links) {
      expect(hrefOf(link).searchParams.has("app")).toBe(false);
      expect(link.getAttribute("href")).not.toContain("app=");
    }
  });

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
