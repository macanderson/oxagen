// @vitest-environment jsdom
// People and Invitations share the organization roster read and render only
// the selected section. Existing row writes, refusal states, and empty states
// remain covered on the tab that owns them.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberList } from "@/data/contracts/org";
import type { OrgRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { orgSource } from "./organization.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  changeMemberRole: vi.fn(),
  removeOrgMember: vi.fn(),
  sendInvitation: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { People } = await import("./people");

afterEach(() => {
  cleanup();
});

type Members = Parameters<typeof People>[0]["source"]["org"]["members"];

async function renderPeople(
  read: Awaited<ReturnType<Members>>,
  orgRole: OrgRole = "owner",
  selected: "people" | "invitations" = "people",
) {
  const ctx = unsafeMint(OrgCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
  });
  const { source, calls } = orgSource({ members: read });
  const view = render(
    <IntlProvider>
      {await People({ ctx, source, view: selected })}
    </IntlProvider>,
  );
  expect(calls.members).toEqual([[ctx]]);
  expect(calls.apiKeys).toEqual([]);
  await expectNoAxe(view.container);
  return view;
}

const roster: MemberList = {
  members: [
    {
      id: "usr_7k2m9q4x8r1t5v3w6y0z2a",
      name: "Marcus Bell",
      email: "marcus.bell@acme.example",
      role: "owner",
      joinedAt: "2026-03-02T09:15:00.000Z",
    },
    {
      id: "usr_0a1b2c3d4e5f6g7h8j9k0m",
      name: null,
      email: "ops@acme.example",
      role: "viewer",
      joinedAt: "2026-05-11T16:40:00.000Z",
    },
  ],
  invitations: [
    {
      id: "invi_4n5p6q7r8s9t0v1w2x3y4z",
      email: "dana.reyes@acme.example",
      role: "admin",
      invitedAt: "2026-09-10T12:00:00.000Z",
      expiresAt: "2026-09-17T12:00:00.000Z",
    },
    {
      id: "invi_9z8y7x6w5v4t3s2r1q0p9n",
      email: "audit@acme.example",
      role: "compliance",
      invitedAt: "2026-09-01T08:00:00.000Z",
      expiresAt: null,
    },
  ],
};

function sectionTitles(): (string | null)[] {
  return screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
}

describe("People tabs", () => {
  it("link People, Roles and API keys by URL, People marked as the current page", async () => {
    await renderPeople(readOk(roster));
    const tabs = screen.getByRole("navigation", { name: "Organization" });
    const people = within(tabs).getByRole("link", { name: "People" });
    const roles = within(tabs).getByRole("link", { name: "Roles" });
    const keys = within(tabs).getByRole("link", { name: "API keys" });
    expect(people).toHaveAttribute("href", "/acme");
    expect(people).toHaveAttribute("aria-current", "page");
    expect(roles).toHaveAttribute("href", "/acme/roles");
    expect(roles).not.toHaveAttribute("aria-current");
    expect(keys).toHaveAttribute("href", "/acme/api-keys");
    expect(keys).not.toHaveAttribute("aria-current");
  });
});

it("marks Invitations selected and preserves the People destination", async () => {
  await renderPeople(readOk(roster), "owner", "invitations");
  const tabs = screen.getByRole("navigation", { name: "Organization" });
  expect(
    within(tabs).getByRole("link", { name: "Invitations" }),
  ).toHaveAttribute("href", "/acme?tab=invitations");
  expect(
    within(tabs).getByRole("link", { name: "Invitations" }),
  ).toHaveAttribute("aria-current", "page");
  expect(
    within(tabs).getByRole("link", { name: "People" }),
  ).not.toHaveAttribute("aria-current");
  expect(sectionTitles()).toEqual(["Pending invitations"]);
  expect(screen.queryByRole("region", { name: "People" })).toBeNull();
});

describe("ok", () => {
  it("lists each member with name, email, role and join date", async () => {
    await renderPeople(readOk(roster));
    const members = screen.getByRole("region", { name: "People" });
    const [marcus, unnamed] = within(members).getAllByRole("row").slice(1);
    expect(marcus).toHaveAttribute("data-member", "usr_7k2m9q4x8r1t5v3w6y0z2a");
    expect(marcus).toHaveTextContent("Marcus Bell");
    expect(marcus).toHaveTextContent("marcus.bell@acme.example");
    expect(marcus).toHaveTextContent("Owner");
    expect(within(members).getByText("Mar 2, 2026")).toHaveAttribute(
      "datetime",
      "2026-03-02T09:15:00.000Z",
    );
    expect(unnamed).toHaveTextContent("Viewer");
    expect(within(members).getAllByText("ops@acme.example")).toHaveLength(1);
  });

  it("lists each pending invitation with email, role offered, sent and expiry, and Never for one that does not expire", async () => {
    await renderPeople(readOk(roster), "owner", "invitations");
    const invitations = screen.getByRole("region", {
      name: "Pending invitations",
    });
    const [dana, audit] = within(invitations).getAllByRole("row").slice(1);
    expect(dana).toHaveAttribute(
      "data-invitation",
      "invi_4n5p6q7r8s9t0v1w2x3y4z",
    );
    expect(dana).toHaveTextContent("dana.reyes@acme.example");
    expect(dana).toHaveTextContent("Admin");
    expect(dana).toHaveTextContent("Sep 10, 2026");
    expect(dana).toHaveTextContent("Sep 17, 2026");
    expect(audit).toHaveTextContent("Compliance");
    expect(audit).toHaveTextContent("Never");
  });

  it("keeps invitations and workspace tables off People (negative)", async () => {
    await renderPeople(readOk(roster));
    expect(sectionTitles()).toEqual(["People"]);
    expect(screen.queryByTestId("not-recorded")).toBeNull();
    expect(screen.queryByText(/settings/i)).toBeNull();
    expect(screen.queryByRole("region", { name: "Workspaces" })).toBeNull();
  });
});

describe("the writes on a member's row", () => {
  it("an Owner opens the two writes on every member", async () => {
    await renderPeople(readOk(roster));
    const members = screen.getByRole("region", { name: "People" });
    for (const row of within(members).getAllByRole("row").slice(1)) {
      expect(
        within(row).getByRole("button", { name: "Change role" }),
      ).toBeInTheDocument();
      expect(
        within(row).getByRole("button", { name: "Remove" }),
      ).toBeInTheDocument();
    }
    expect(screen.queryByTestId("member-actions-denied")).toBeNull();
  });

  it("a Member sees the roster with both writes refused, and opens neither (negative)", async () => {
    await renderPeople(readOk(roster), "member");
    const members = screen.getByRole("region", { name: "People" });
    const rows = within(members).getAllByRole("row").slice(1);
    expect(screen.getAllByTestId("member-actions-denied")).toHaveLength(
      rows.length,
    );
    expect(screen.getAllByTestId("member-actions-denied")[0]).toHaveTextContent(
      "Changing a role and removing a member are Owner and Admin actions.",
    );
    expect(screen.queryByRole("button", { name: "Change role" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});

describe("the Invite control", () => {
  it("an Owner opens it from the Pending invitations section", async () => {
    await renderPeople(readOk(roster), "owner", "invitations");
    const invitations = screen.getByRole("region", {
      name: "Pending invitations",
    });
    expect(
      within(invitations).getByRole("button", { name: "Invite" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("invite-denied")).toBeNull();
  });

  it("a Member reads the refusal in its place, and opens nothing (negative)", async () => {
    await renderPeople(readOk(roster), "member", "invitations");
    expect(screen.getByTestId("invite-denied")).toHaveTextContent(
      "Inviting someone is an Owner and Admin action.",
    );
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
  });

  it("stays offered when no invitation is waiting", async () => {
    await renderPeople(
      readOk({ members: [], invitations: [] }),
      "owner",
      "invitations",
    );
    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
  });

  it("is not offered when the read did not list (negative)", async () => {
    await renderPeople(
      readError("control_plane_unavailable", 503),
      "owner",
      "invitations",
    );
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.queryByTestId("invite-denied")).toBeNull();
  });
});

describe("empty", () => {
  it.each([
    ["people", "People", "This organization has no members."],
    [
      "invitations",
      "Pending invitations",
      "No invitations are waiting for an answer.",
    ],
  ] as const)(
    "keeps the %s empty state in its selected section",
    async (selected, title, message) => {
      await renderPeople(
        readOk({ members: [], invitations: [] }),
        "owner",
        selected,
      );
      expect(sectionTitles()).toEqual([title]);
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.queryByRole("table")).toBeNull();
    },
  );
});

describe("a read that did not list", () => {
  it("denied: a Member viewer sees their role and the permission needed, and no roster (negative)", async () => {
    await renderPeople(
      { ok: false, reason: "denied", permission: "org.admin" },
      "member",
    );
    const panel = screen.getByTestId("people-denied");
    expect(panel).toHaveTextContent(
      "You cannot see this organization’s people",
    );
    expect(panel).toHaveTextContent("Signed in as Member. Needed: org.admin.");
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByRole("navigation", { name: "Organization" }),
    ).toBeInTheDocument();
  });

  it("pending approval: names the access request it waits on, and no roster (negative)", async () => {
    await renderPeople({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "areq_5t6u7v8w",
    });
    expect(screen.getByTestId("people-pending")).toHaveTextContent(
      "Access request areq_5t6u7v8w is waiting for an owner’s decision.",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("error: names the status and code, and no roster (negative)", async () => {
    await renderPeople(readError("control_plane_unavailable", 503));
    const panel = screen.getByTestId("people-error");
    expect(panel).toHaveTextContent("Organization could not be loaded");
    expect(panel).toHaveTextContent("503 control_plane_unavailable");
    expect(screen.queryByRole("table")).toBeNull();
  });
});
