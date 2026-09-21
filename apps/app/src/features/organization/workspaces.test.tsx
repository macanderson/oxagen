// @vitest-environment jsdom
// Organization › Workspaces over org.workspaces: the live and archived rows,
// the state as a dot and a word, the writes an owner is offered and a member
// is not, the empty line, and the denied and error states that replace the
// table. Every state is checked with axe.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceList } from "@/data/contracts/org";
import type { OrgRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { workspaceRow } = await import("./organization.builders");
const { Workspaces } = await import("./workspaces");

afterEach(() => {
  cleanup();
});

type Read = Parameters<typeof Workspaces>[0]["source"]["org"]["workspaces"];

async function renderWorkspaces(
  read: Awaited<ReturnType<Read>>,
  orgRole: OrgRole = "owner",
) {
  const ctx = unsafeMint(OrgCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
  });
  const workspaces = vi.fn<Read>().mockResolvedValue(read);
  const source = {
    pretenant: { orgs: vi.fn(), workspaces: vi.fn() },
    shell: { context: vi.fn(), preferences: vi.fn() },
    billing: {
      plan: vi.fn(),
      usageCredits: vi.fn(),
      bucket: vi.fn(),
      contractRate: vi.fn(),
      invoices: vi.fn(),
    },
    runs: {
      list: vi.fn(),
      get: vi.fn(),
      frameBody: vi.fn(),
      cost: vi.fn(),
      transcript: vi.fn(),
      chain: vi.fn(),
    },
    approvals: { pending: vi.fn(), resolved: vi.fn() },
    agents: {
      list: vi.fn(),
      get: vi.fn(),
      toolbelt: vi.fn(),
      incidents: vi.fn(),
    },
    spend: {
      byGroup: vi.fn(),
      fleet: vi.fn(),
      drill: vi.fn(),
      waste: vi.fn(),
      budgets: vi.fn(),
      findings: vi.fn(),
      findingEvidence: vi.fn(),
      priceBook: vi.fn(),
      unpricedModels: vi.fn(),
    },
    onboarding: { state: vi.fn(), firstFrame: vi.fn() },
    org: {
      members: vi.fn(),
      roles: vi.fn(),
      workspaces,
      apiKeys: vi.fn(),
      modelCredential: vi.fn(),
    },
    mandates: { list: vi.fn(), get: vi.fn() },
    audit: { events: vi.fn(), exportEvents: vi.fn() },
    skills: { inventory: vi.fn(), configuration: vi.fn() },
    steering: {
      records: vi.fn(),
      proposals: vi.fn(),
      contextPr: vi.fn(),
      freshness: vi.fn(),
    },
    tools: {
      versions: vi.fn(),
      grants: vi.fn(),
      killSwitches: vi.fn(),
      approvalRules: vi.fn(),
      connections: vi.fn(),
      mcpServers: vi.fn(),
    },
  };
  const view = render(
    <IntlProvider>{await Workspaces({ ctx, source })}</IntlProvider>,
  );
  expect(workspaces).toHaveBeenCalledWith(ctx);
  await expectNoAxe(view.container);
  return view;
}

const list: WorkspaceList = {
  workspaces: [
    workspaceRow(),
    workspaceRow({
      id: "wrk_9z8y7x6w5v4t3s2r1q0p9n",
      slug: "research",
      name: "Research",
      role: null,
      archivedAt: "2026-09-01T08:00:00.000Z",
    }),
  ],
};

describe("ok", () => {
  it("lists each workspace with its slug, the viewer's role and its state", async () => {
    await renderWorkspaces(readOk(list));
    const section = screen.getByRole("region", { name: "Workspaces" });
    const [core, research] = within(section).getAllByRole("row").slice(1);
    if (core === undefined || research === undefined)
      throw new Error("expected two workspace rows");
    expect(core).toHaveAttribute(
      "data-workspace",
      "wrk_0a1b2c3d4e5f6g7h8j9k0m",
    );
    expect(core).toHaveTextContent("Core platform");
    expect(core).toHaveTextContent("core-platform");
    expect(core).toHaveTextContent("Owner");
    expect(within(core).getByText("live")).toHaveAttribute(
      "data-status",
      "live",
    );
    expect(research).toHaveTextContent("No membership");
    expect(within(research).getByText("archived")).toHaveAttribute(
      "data-status",
      "archived",
    );
  });

  // An archived workspace is offered neither control.
  // `update_workspace_settings` refuses it (`workspace_archived`): releasing
  // its slug would let a new workspace take it, and a direct slug match then
  // beats the archived workspace's slug-history redirect, breaking the
  // guarantee `archive_workspace` makes. Offering Edit on a row whose every
  // edit is refused is a control that does nothing.
  it("offers create, and edit and archive only on a live workspace (negative)", async () => {
    await renderWorkspaces(readOk(list));
    expect(
      screen.getByRole("button", { name: "Create a workspace" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(1);
  });
});

describe("empty", () => {
  it("says so in place of the table, and still offers the first workspace", async () => {
    await renderWorkspaces(readOk({ workspaces: [] }));
    expect(
      screen.getByText("This organization has no workspaces."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create a workspace" }),
    ).toBeInTheDocument();
  });
});

describe("a viewer who cannot write", () => {
  it("names who can and offers no control (negative)", async () => {
    await renderWorkspaces(readOk(list), "member");
    expect(
      screen.getByText("An owner or an admin makes these changes."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(within(screen.getByRole("table")).queryByText("Actions")).toBeNull();
  });
});

describe("a read that did not list", () => {
  it("denied: says which permission is needed and lists nothing (negative)", async () => {
    await renderWorkspaces({
      ok: false,
      reason: "denied",
      permission: "org.admin",
    });
    expect(screen.getByText(/org.admin/)).toHaveAttribute(
      "data-reason",
      "denied",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("error: names the code and lists nothing (negative)", async () => {
    await renderWorkspaces(readError("control_plane_unavailable", 503));
    expect(screen.getByText(/control_plane_unavailable/)).toHaveAttribute(
      "data-reason",
      "error",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });
});
