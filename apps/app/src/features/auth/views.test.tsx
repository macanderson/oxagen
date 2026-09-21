// @vitest-environment jsdom
// Server Components render here by awaiting them into elements first; the client
// islands inside render under the intl provider.
import { createFormatter } from "next-intl";
import { cleanup, render, screen } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (ns: string) => Promise.resolve(translator(ns)),
  getRequestConfig: <T,>(factory: T) => factory,
  getFormatter: async () => {
    const { default: factory } = await import("@/i18n/request");
    const config = await factory({ requestLocale: Promise.resolve(undefined) });
    return createFormatter({
      locale: config.locale,
      timeZone: config.timeZone ?? "UTC",
    });
  },
}));
vi.mock("./invite-actions", () => ({
  acceptInvitation: vi.fn(),
  declineInvitation: vi.fn(),
}));

/** Synchronous Server Components to expand in place (they may hold async children). */
const SERVER_SYNC = new Set<unknown>();

const { InvitationBody, InvitationNotFound } = await import("./invite-view");
const { AuthColumn, AuthFooter, AuthShell, AuthSkeleton } = await import(
  "@/ui/auth-shell"
);
const { OutcomePanel } = await import("@/ui/form-feedback");
for (const component of [AuthShell, AuthColumn, AuthFooter])
  SERVER_SYNC.add(component);

type ServerComponent = (
  props: Record<string, unknown>,
) => ReactNode | Promise<ReactNode>;

/** An async component, or a synchronous one listed in SERVER_SYNC. */
function isServerComponent(type: unknown): type is ServerComponent {
  return (
    typeof type === "function" &&
    (type.constructor.name === "AsyncFunction" || SERVER_SYNC.has(type))
  );
}

/** Resolve server components in a tree so the result renders synchronously. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  if (isServerComponent(node.type)) return resolve(await node.type(node.props));
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.props))
    props[k] = await resolveProp(v);
  return { ...node, props };
}

/** A prop that holds elements (children, slots) is resolved; any other value is kept. */
async function resolveProp(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(resolveProp));
  return isValidElement(value) ? resolve(value) : value;
}

async function renderServer(node: ReactNode) {
  return render(<IntlProvider>{await resolve(node)}</IntlProvider>);
}

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it, portals included.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

const invitation = {
  token: "invi_1",
  orgName: "Acme Robotics",
  orgSlug: "acme",
  email: "marcus.bell@acme.example",
  role: "compliance" as const,
  status: "pending" as const,
  invitedAt: "2026-09-11T09:00:00.000Z",
  expiresAt: null,
};

describe("InvitationBody", () => {
  it("accept · shows what the invitation grants, with the accept island", async () => {
    await renderServer(
      <InvitationBody invitation={invitation} decision={{ kind: "accept" }} />,
    );
    expect(screen.getByTestId("invite-card")).toHaveTextContent(
      "You were invited on Sep 11, 2026",
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

  it.each(["accept", "sign-in"] as const)(
    "formats invitation dates in Pacific outside the organization shell: %s",
    async (kind) => {
      await renderServer(
        <InvitationBody
          invitation={{
            ...invitation,
            invitedAt: "2026-09-11T01:00:00.000Z",
            expiresAt: "2026-09-12T01:00:00.000Z",
          }}
          decision={{ kind }}
        />,
      );
      const card = screen.getByTestId("invite-card");
      expect(card).toHaveTextContent("You were invited on Sep 10, 2026");
      expect(card).toHaveTextContent("Sep 11, 2026");
      expect(card).not.toHaveTextContent("Sep 12, 2026");
    },
  );

  it("sign in · offers log in and sign up carrying the invitation", async () => {
    await renderServer(
      <InvitationBody
        invitation={{
          ...invitation,
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
          <h1>Title</h1>
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
