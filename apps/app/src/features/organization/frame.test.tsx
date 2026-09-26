// @vitest-environment jsdom
// The Organization frame (pages/organization.md): the org.admin check on the
// server, the header and the seven design tabs with their counts, and the
// empty, error and denied states that replace the body. Each state's copy is
// the design's, verbatim, and every state is checked with axe.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import {
  orgSource,
  roleCatalog,
  roleRow,
  workspaceRow,
} from "./organization.builders";

const { getSession, mfaPolicy } = vi.hoisted(() => ({
  getSession: vi.fn(),
  mfaPolicy: vi.fn(),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: { mfaPolicy } }));
vi.mock("./actions", () => ({
  sendInvitation: vi.fn(),
  createWorkspace: vi.fn(),
  setOrgAvatar: vi.fn(),
  setWorkspaceAvatar: vi.fn(),
}));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { OrganizationFrame } = await import("./frame");

beforeEach(() => {
  mfaPolicy.mockReset();
  mfaPolicy.mockResolvedValue(null);
  getSession.mockResolvedValue({
    user: { name: "Marcus Bell", email: "marcus@acme.example" },
  });
});
afterEach(cleanup);

const roster = {
  members: [
    {
      id: "usr_7k2m9q4x8r1t5v3w6y0z2a",
      name: "Marcus Bell",
      email: "marcus@acme.example",
      role: "owner" as const,
      joinedAt: "2026-03-02T09:15:00.000Z",
    },
  ],
  invitations: [
    {
      id: "invi_4n5p6q7r8s9t0v1w2x3y4z",
      email: "dana@acme.example",
      role: "admin" as const,
      invitedAt: "2026-09-10T12:00:00.000Z",
      expiresAt: null,
    },
  ],
};

function ctxFor(role: OrgRole) {
  return unsafeMint(OrgCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole: role,
  });
}

async function renderFrame(
  role: OrgRole,
  reads: Parameters<typeof orgSource>[0],
) {
  const ctx = ctxFor(role);
  const { source, calls } = orgSource(reads);
  const body = vi.fn(() => <p data-testid="tab-body">tab</p>);
  const view = render(
    <IntlProvider>
      {
        await OrganizationFrame({
          ctx,
          source,
          current: "people",
          retry: routes.people("acme"),
          children: body,
        })
      }
    </IntlProvider>,
  );
  await expectNoAxe(view.container);
  return { calls, body, view };
}

const loaded = {
  members: readOk(roster),
  roles: readOk(
    roleCatalog({
      roles: [
        roleRow(),
        roleRow({ id: "rol_2", name: "Owner", kind: "human" }),
      ],
    }),
  ),
  workspaces: readOk({
    orgId: "org_7k2m9q4x8r1t5v3w6y0z2a",
    orgAvatarUrl: null,
    workspaces: [
      workspaceRow(),
      workspaceRow({
        id: "wrk_2",
        slug: "old",
        archivedAt: "2026-01-01T00:00:00.000Z",
      }),
    ],
  }),
};

describe("loaded", () => {
  it.each(["owner", "admin"] as const)(
    "draws the header, the tabs with their counts and the tab body for %s",
    async (role) => {
      const { calls, body } = await renderFrame(role, loaded);
      expect(
        screen.getByRole("heading", { level: 1, name: "Acme Robotics" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Organization", { selector: "p" })).toBeTruthy();
      // No avatar is set, so the header keeps the gold letter tile.
      const avatar = screen.getByTestId("organization-avatar");
      expect(avatar).toHaveAttribute("data-tone", "gold");
      expect(avatar).toHaveTextContent(/^A$/);
      expect(
        screen.getByText(
          "People, roles, workspaces, model routes, the data plane, and API keys.",
        ),
      ).toBeInTheDocument();
      const invite = screen.getByRole("button", { name: "Invite" });
      const create = screen.getByRole("button", {
        name: "Create a workspace",
      });
      // Header order: Invite, then the one gold action.
      expect(
        invite.compareDocumentPosition(create) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(create.className).toContain("bg-button-primary-bg");
      expect(invite.className).not.toContain("bg-button-primary-bg");

      const tabs = within(
        screen.getByRole("tablist", { name: "Organization" }),
      ).getAllByRole("tab");
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        "People1",
        "Roles2",
        "Invitations1",
        "Workspaces2",
        "Model funding and routes",
        "Data plane",
        "API keys",
      ]);
      expect(tabs[0]).toHaveAttribute("aria-current", "page");
      expect(tabs[0]).toHaveAttribute("aria-selected", "true");
      expect(tabs[1]).toHaveAttribute("aria-selected", "false");
      expect(tabs[2]).toHaveAttribute("href", "/acme?tab=invitations");
      expect(tabs[5]).toHaveAttribute("href", "/acme?tab=dataPlane");
      expect(screen.getByTestId("tab-body")).toBeInTheDocument();
      // A write's receipt lands in the frame's live region, whichever tab made it.
      expect(screen.getByTestId("organization-receipts")).toHaveAttribute(
        "aria-live",
        "polite",
      );
      expect(body).toHaveBeenCalledWith({
        members: roster,
        roles: loaded.roles.ok ? loaded.roles.value : null,
        workspaces: loaded.workspaces.ok ? loaded.workspaces.value : null,
        // No policy row requires nothing, as the MFA gate reads it.
        twoFactor: { required: false },
        // The live workspaces the viewer belongs to; the archived one is not.
        enterable: [workspaceRow().slug],
      });
      expect(calls.members).toHaveLength(1);
      expect(calls.roles).toHaveLength(1);
    },
  );

  it("opens Edit avatar on the organization's stored avatar", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const stored = 'avatar:v1:{"kind":"icon","icon":"rocket","tone":"gold"}';
    await renderFrame("owner", {
      ...loaded,
      workspaces: readOk({
        orgId: "org_7k2m9q4x8r1t5v3w6y0z2a",
        orgAvatarUrl: stored,
        workspaces: [workspaceRow()],
      }),
    });
    // The header draws the stored avatar before the name.
    expect(screen.getByTestId("organization-avatar")).toHaveAttribute(
      "data-icon",
      "rocket",
    );
    await userEvent.click(screen.getByTestId("edit-org-avatar"));
    const dialog = await screen.findByTestId("edit-org-avatar-dialog");
    expect(dialog).toHaveTextContent("Avatar for Acme Robotics");
    expect(within(dialog).getByTestId("avatar-icon-rocket")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).getByTestId("avatar-tone-gold")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).getByTestId("avatar-remove")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe("the two-factor policy", () => {
  it("reads the organization's policy from the record the MFA gate enforces, and hands it to the tab", async () => {
    mfaPolicy.mockResolvedValue({
      mfaRequired: true,
      mfaGraceHours: 72,
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const { body } = await renderFrame("owner", loaded);
    expect(mfaPolicy).toHaveBeenCalledWith(
      "7a000000-0000-4000-8000-0000000000a1",
    );
    expect(body).toHaveBeenCalledWith(
      expect.objectContaining({ twoFactor: { required: true } }),
    );
  });

  it("reads no policy for a viewer the frame refuses (negative)", async () => {
    await renderFrame("member", { workspaces: loaded.workspaces });
    expect(mfaPolicy).not.toHaveBeenCalled();
  });
});

describe("access denied", () => {
  it.each(["member", "viewer", "billing", "compliance"] as const)(
    "refuses %s on the server before reading the roster",
    async (role) => {
      const { calls, body } = await renderFrame(role, {
        workspaces: loaded.workspaces,
      });
      expect(calls.members).toEqual([]);
      expect(calls.roles).toEqual([]);
      expect(body).not.toHaveBeenCalled();
      const denied = screen.getByTestId("organization-denied");
      expect(
        within(denied).getByRole("heading", {
          name: "You cannot see this organization’s settings",
        }),
      ).toBeInTheDocument();
      expect(denied).toHaveTextContent(
        "Your roles on Acme Robotics do not include org.admin (members, funding, and the data plane are owner-only).",
      );
      expect(denied).toHaveTextContent(
        "An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
      );
      expect(
        within(denied).getByRole("link", { name: "Back to Fleet" }),
      ).toHaveAttribute("href", "/acme/core-platform");
      expect(screen.getByTestId("denied-signed-in")).toHaveTextContent(
        "Marcus Bell",
      );
      expect(denied).toHaveTextContent("Needed");
      expect(denied).toHaveTextContent("Decided by");
      expect(
        screen.queryByRole("heading", { level: 1, name: "Acme Robotics" }),
      ).toBeNull();
    },
  );

  it("opens Request access as a dialog that says nothing was sent", async () => {
    await renderFrame("member", { workspaces: loaded.workspaces });
    await userEvent.click(
      screen.getByRole("button", { name: "Request access" }),
    );
    expect(screen.getByTestId("organization-request-access")).toHaveTextContent(
      "nothing is sent from here",
    );
  });

  it("draws the denied state when a read is refused", async () => {
    await renderFrame("admin", {
      ...loaded,
      members: { ok: false, reason: "denied", permission: "org.admin" },
    });
    expect(screen.getByTestId("organization-denied")).toBeInTheDocument();
  });
});

describe("error", () => {
  it("names the status and the code, and offers Try again and Open an incident", async () => {
    const { body } = await renderFrame("owner", {
      ...loaded,
      roles: readError("control_plane_unavailable", 503),
    });
    expect(body).not.toHaveBeenCalled();
    const error = screen.getByTestId("organization-error");
    expect(
      within(error).getByRole("heading", {
        name: "Organization could not be loaded",
      }),
    ).toBeInTheDocument();
    expect(error).toHaveTextContent(
      "The control plane answered 503 control_plane_unavailable. Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
    );
    expect(
      within(error).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", "/acme");
    expect(screen.getByTestId("organization-error-trace")).toHaveTextContent(
      /trace not recorded · region not recorded · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z/,
    );
    await userEvent.click(
      within(error).getByRole("button", { name: "Open an incident" }),
    );
    expect(screen.getByTestId("organization-incident")).toHaveTextContent(
      "503 control_plane_unavailable",
    );
  });
});

describe("empty", () => {
  it("says the organization has no workspaces when none is live, with Create a workspace in gold", async () => {
    const { body } = await renderFrame("owner", {
      ...loaded,
      workspaces: readOk({
        orgId: "org_7k2m9q4x8r1t5v3w6y0z2a",
        orgAvatarUrl: null,
        workspaces: [workspaceRow({ archivedAt: "2026-01-01T00:00:00.000Z" })],
      }),
    });
    expect(body).not.toHaveBeenCalled();
    const empty = screen.getByTestId("organization-empty");
    expect(
      within(empty).getByRole("heading", {
        name: "This organization has no workspaces",
      }),
    ).toBeInTheDocument();
    expect(empty).toHaveTextContent(
      "A workspace owns one main repo, one steering set, a set of agents, tool grants, and budgets. A workspace without a main repo cannot exist.",
    );
    expect(
      within(empty).getByRole("button", { name: "Create a workspace" })
        .className,
    ).toContain("bg-button-primary-bg");
  });
});

describe("loading", () => {
  it("holds the body with four tile blocks and a panel of seven rows, no figure and no zero", async () => {
    const { OrganizationSkeleton } = await import("./states");
    const view = render(
      <IntlProvider>
        <OrganizationSkeleton />
      </IntlProvider>,
    );
    const skeleton = screen.getByTestId("organization-loading");
    expect(skeleton).toHaveAttribute("role", "status");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton.querySelectorAll('[data-skeleton="tile"]')).toHaveLength(4);
    expect(skeleton.querySelectorAll('[data-skeleton="row"]')).toHaveLength(7);
    // Every bone is the design's shimmer, as on every other page, and none pulses.
    expect(skeleton.querySelectorAll(".skeleton")).toHaveLength(12);
    expect(skeleton.querySelector(".animate-pulse")).toBeNull();
    expect(skeleton).not.toHaveTextContent(/\d/);
    await expectNoAxe(view.container);
  });
});
