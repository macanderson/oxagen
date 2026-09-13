// @vitest-environment jsdom
// Server Components render here by awaiting them into elements first; the client
// islands inside render under the intl provider.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntlProvider, translator } from "./test-intl";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (ns: string) => Promise.resolve(translator(ns)),
  getFormatter: () =>
    Promise.resolve({ dateTime: (d: Date) => d.toISOString().slice(0, 10) }),
}));
vi.mock("./invite-actions", () => ({
  acceptInvitation: vi.fn(),
  declineInvitation: vi.fn(),
}));
const cliActions = { approveCliAuth: vi.fn(), cancelCliAuth: vi.fn() };
vi.mock("./cli-actions", () => cliActions);

/** Synchronous Server Components to expand in place (they may hold async children). */
const SERVER_SYNC = new Set<unknown>();

const { InvitationBody, InvitationNotFound } = await import("./invite-view");
const {
  AuthColumn,
  AuthFooter,
  AuthHeading,
  AuthShell,
  AuthSkeleton,
  Brandmark,
} = await import("./ui/auth-shell");
const { OutcomePanel } = await import("./ui/feedback");
const { CliConsentForm } = await import("./cli-consent-form");
const { GateShell, GateSkeleton, StepHeading } = await import(
  "../onboarding/ui/gate-shell"
);
for (const component of [
  AuthShell,
  AuthColumn,
  AuthHeading,
  AuthFooter,
  StepHeading,
])
  SERVER_SYNC.add(component);

/** Resolve server components in a tree so the result renders synchronously. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<Record<string, unknown>>;
  if (
    typeof el.type === "function" &&
    (el.type.constructor.name === "AsyncFunction" || SERVER_SYNC.has(el.type))
  ) {
    return resolve(
      await (el.type as (p: unknown) => Promise<ReactNode>)(el.props),
    );
  }
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el.props))
    props[k] =
      isValidElement(v) || Array.isArray(v) ? await resolve(v as ReactNode) : v;
  return { ...el, props } as ReactNode;
}

async function renderServer(node: ReactNode) {
  return render(<IntlProvider>{await resolve(node)}</IntlProvider>);
}

afterEach(() => {
  cleanup();
});

const invitation = {
  token: "invi_1",
  orgName: "Acme Robotics",
  orgSlug: "acme",
  email: "marcus.bell@acme.example",
  role: "compliance" as const,
  status: "pending" as const,
  inviterName: "Priya Raman",
  invitedAt: "2026-09-11T09:00:00.000Z",
  expiresAt: null,
};

describe("InvitationBody", () => {
  it("accept · shows what the invitation grants, with the accept island", async () => {
    await renderServer(
      <InvitationBody invitation={invitation} decision={{ kind: "accept" }} />,
    );
    expect(screen.getByTestId("invite-card")).toHaveTextContent(
      "Priya Raman invited you",
    );
    expect(screen.getByText("compliance")).toBeInTheDocument();
    expect(screen.getByText("Does not expire")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Accept invitation" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Not you?" })).toHaveAttribute(
      "href",
      "/login?next=%2Finvite%2Finvi_1",
    );
  });

  it("sign in · offers log in and sign up carrying the invitation", async () => {
    await renderServer(
      <InvitationBody
        invitation={{
          ...invitation,
          inviterName: null,
          expiresAt: "2026-09-18T09:00:00.000Z",
        }}
        decision={{ kind: "sign-in" }}
      />,
    );
    expect(screen.getByText("You were invited")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Create an account" }),
    ).toHaveAttribute("href", "/signup?next=%2Finvite%2Finvi_1");
    expect(screen.getByText("2026-09-18")).toBeInTheDocument();
  });

  it("wrong account and closed", async () => {
    const { unmount } = await renderServer(
      <InvitationBody
        invitation={invitation}
        decision={{ kind: "wrong-account", signedInAs: "dana@acme.example" }}
      />,
    );
    expect(screen.getByTestId("invite-wrong-account")).toHaveTextContent(
      "You are logged in as dana@acme.example",
    );
    unmount();
    const closed = await renderServer(
      <InvitationBody
        invitation={invitation}
        decision={{ kind: "closed", status: "accepted" }}
      />,
    );
    expect(screen.getByTestId("invite-closed-accepted")).toHaveTextContent(
      "already been accepted",
    );
    closed.unmount();
    await renderServer(
      <InvitationBody
        invitation={invitation}
        decision={{ kind: "closed", status: "revoked" }}
      />,
    );
    expect(screen.queryByRole("link", { name: "Log in to accept" })).toBeNull();
  });

  it("not found", async () => {
    await renderServer(<InvitationNotFound />);
    expect(screen.getByTestId("invite-not-found")).toHaveTextContent(
      "does not work",
    );
  });
});

describe("auth frame", () => {
  it("renders the brand, one main landmark and the column pieces", async () => {
    await renderServer(
      <AuthShell aside={<span>aside</span>}>
        <AuthColumn wide>
          <AuthHeading kicker="Kicker" title="Title" lead="Lead" />
          <AuthFooter>Footer</AuthFooter>
        </AuthColumn>
      </AuthShell>,
    );
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Oxagen home" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Title" }),
    ).toBeInTheDocument();
    expect(screen.getByText("aside")).toBeInTheDocument();
    await renderServer(<Brandmark />);
  });

  it("skeleton and outcome tones", async () => {
    await renderServer(
      <>
        <AuthSkeleton />
        <OutcomePanel tone="ok" title="ok" testId="ok" />
        <OutcomePanel tone="deny" title="deny" />
        <OutcomePanel
          tone="neutral"
          title="neutral"
          actions={<button type="button">act</button>}
        >
          body
        </OutcomePanel>
      </>,
    );
    expect(screen.getByTestId("page-state-loading")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ok" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "act" })).toBeInTheDocument();
  });
});

describe("CliConsentForm", () => {
  const params = {
    redirectUri: "http://127.0.0.1:53682/callback",
    state: "st_1",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    codeChallengeMethod: "S256",
    label: "laptop",
  };
  const orgs = [
    {
      id: "o1",
      slug: "acme",
      name: "Acme",
      workspaces: [{ id: "w1", slug: "core", name: "core" }],
    },
    {
      id: "o2",
      slug: "globex",
      name: "Globex",
      workspaces: [
        { id: "w2", slug: "labs", name: "labs" },
        { id: "w3", slug: "ops", name: "ops" },
      ],
    },
  ];

  it("picks an org and its first workspace, carrying every parameter as a hidden field", async () => {
    render(
      <IntlProvider>
        <CliConsentForm params={params} orgs={orgs} />
      </IntlProvider>,
    );
    expect(screen.getByLabelText("Workspace")).toHaveValue("core");
    await userEvent.selectOptions(
      screen.getByLabelText("Organization"),
      "globex",
    );
    expect(screen.getByLabelText("Workspace")).toHaveValue("labs");
    await userEvent.selectOptions(screen.getByLabelText("Workspace"), "ops");
    expect(screen.getByLabelText("Workspace")).toHaveValue("ops");
    const hidden = document.querySelectorAll(
      'input[type="hidden"][name="code_challenge"]',
    );
    expect(hidden).toHaveLength(2);
  });

  it("an organization with no workspace cannot be approved", () => {
    render(
      <IntlProvider>
        <CliConsentForm
          params={params}
          orgs={[{ id: "o3", slug: "empty", name: "Empty", workspaces: [] }]}
        />
      </IntlProvider>,
    );
    expect(
      screen.getByText("No workspaces in this organization."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });
});

describe("GateShell", () => {
  it("gate · a main landmark, done steps link back, the current step is marked", async () => {
    await renderServer(
      <GateShell
        mode="gate"
        step="run"
        email="m@acme.example"
        links={{ org: "acme", ws: "core-platform", choice: null }}
      >
        <StepHeading index={2} total={3} title="Start a run" lead="Lead" />
      </GateShell>,
    );
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Done: Name the organization" }),
    ).toHaveAttribute("href", "/welcome");
    expect(
      screen.getByRole("link", { name: "Done: Wrap an agent" }),
    ).toHaveAttribute("href", "/welcome/wrap?org=acme&ws=core-platform");
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Cancel" })).toBeNull();
  });

  it("register · a labelled region, not a second main, with cancel", async () => {
    await renderServer(
      <GateShell
        mode="register"
        step="wrap"
        email={null}
        cancelHref="/acme/core-platform"
        links={{
          org: "acme",
          ws: "core-platform",
          choice: { agent: "perf-watch", harness: "custom", tier: "complex" },
        }}
      >
        <p>child</p>
      </GateShell>,
    );
    expect(screen.queryByRole("main")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Register an agent" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute(
      "href",
      "/acme/core-platform",
    );
    expect(
      screen.getByRole("link", { name: "Done: Name the agent" }),
    ).toHaveAttribute("href", "/acme/core-platform/register");
  });

  it("skeleton", async () => {
    await renderServer(<GateSkeleton />);
    expect(screen.getByTestId("page-state-loading")).toBeInTheDocument();
  });
});
