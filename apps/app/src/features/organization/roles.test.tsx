// @vitest-environment jsdom
// Organization › Roles over org.roles: the tabs, each role with what it
// allows and where it came from, the permission catalogue, the line that says
// whether Oxagen resolves these grants for this organization, the writes an
// owner is offered and a member is not, and the denied and error states that
// replace the sections. Every state is checked with axe.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoleCatalog } from "@/data/contracts/org";
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
const { permissionEntry, roleCatalog, roleRow } = await import(
  "./organization.builders"
);
const { Roles } = await import("./roles");

afterEach(() => {
  cleanup();
});

type Read = Parameters<typeof Roles>[0]["source"]["org"]["roles"];

async function renderRoles(
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
  const roles = vi.fn<Read>().mockResolvedValue(read);
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
      outputs: vi.fn(),
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
      gatewayPolicy: vi.fn(),
      budgets: vi.fn(),
      findings: vi.fn(),
      findingEvidence: vi.fn(),
      priceBook: vi.fn(),
      unpricedModels: vi.fn(),
    },
    onboarding: { state: vi.fn(), firstFrame: vi.fn() },
    org: {
      members: vi.fn(),
      roles,
      workspaces: vi.fn(),
      apiKeys: vi.fn(),
      costCenters: vi.fn(),
      modelCredential: vi.fn(),
    },
    mandates: { list: vi.fn(), get: vi.fn() },
    audit: { events: vi.fn(), exportEvents: vi.fn() },
    skills: { inventory: vi.fn(), configuration: vi.fn() },
    steering: {
      records: vi.fn(),
      record: vi.fn(),
      proposals: vi.fn(),
      contextPr: vi.fn(),
      freshness: vi.fn(),
      deliveries: vi.fn(),
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
    <IntlProvider>{await Roles({ ctx, source })}</IntlProvider>,
  );
  expect(roles).toHaveBeenCalledWith(ctx);
  await expectNoAxe(view.container);
  return view;
}

const catalog: RoleCatalog = roleCatalog({
  roles: [
    roleRow(),
    roleRow({
      id: "rol_9z8y7x6w5v4t3s2r1q0p9n",
      name: "Owner",
      description: null,
      scope: "org",
      kind: "human",
      builtIn: true,
      permissions: ["run.read", "budget.set"],
      heldBy: 3,
      createdBy: null,
    }),
  ],
  catalog: [
    permissionEntry(),
    permissionEntry({
      permission: "budget.set",
      group: "Money",
      description: "Read and set spend budgets and the budget policy",
      capabilities: ["get_spend_budget", "set_spend_budget"],
    }),
  ],
});

describe("tabs", () => {
  it("link People, Roles and API keys by URL, Roles marked as the current page", async () => {
    await renderRoles(readOk(catalog));
    const tabs = screen.getByRole("navigation", { name: "Organization" });
    expect(within(tabs).getByRole("link", { name: "People" })).toHaveAttribute(
      "href",
      "/acme",
    );
    const roles = within(tabs).getByRole("link", { name: "Roles" });
    expect(roles).toHaveAttribute("href", "/acme/roles");
    expect(roles).toHaveAttribute("aria-current", "page");
    expect(
      within(tabs).getByRole("link", { name: "API keys" }),
    ).toHaveAttribute("href", "/acme/api-keys");
  });
});

describe("ok", () => {
  it("lists each role with what it allows, who holds it and where it came from", async () => {
    await renderRoles(readOk(catalog));
    const section = screen.getByRole("region", { name: "Roles" });
    const [custom, builtIn] = within(section).getAllByRole("row").slice(1);
    expect(custom).toHaveAttribute("data-role", "rol_7k2m9q4x8r1t5v3w6y0z2a");
    expect(custom).toHaveTextContent("agent.release");
    expect(custom).toHaveTextContent("run.read");
    expect(custom).toHaveTextContent("Agents");
    expect(custom).toHaveTextContent("Workspace");
    expect(custom).toHaveTextContent("Created by Priya Natarajan");
    expect(builtIn).toHaveTextContent("Owner");
    expect(builtIn).toHaveTextContent("People");
    expect(builtIn).toHaveTextContent("Organization");
    expect(builtIn).toHaveTextContent("Built in");
  });

  it("offers the editor on a custom role and nothing on a built-in one (negative)", async () => {
    await renderRoles(readOk(catalog));
    const section = screen.getByRole("region", { name: "Roles" });
    const [custom, builtIn] = within(section).getAllByRole("row").slice(1);
    expect(custom).toHaveTextContent("Edit");
    expect(custom).toHaveTextContent("Delete");
    expect(builtIn).not.toHaveTextContent("Edit");
    expect(builtIn).not.toHaveTextContent("Delete");
    expect(
      screen.getByRole("button", { name: "Create role" }),
    ).toBeInTheDocument();
  });

  it("prints the catalogue a role is written in, with what each permission covers", async () => {
    await renderRoles(readOk(catalog));
    const section = screen.getByRole("region", {
      name: "Permission catalogue",
    });
    expect(section).toHaveTextContent("Runs");
    expect(section).toHaveTextContent("Money");
    const entry = section.querySelector('[data-permission="run.read"]');
    expect(entry).toHaveTextContent(
      "Read runs, their approvals and the commands sent to them",
    );
    expect(entry).toHaveTextContent("3 capabilities");
  });
});

describe("whether these grants are resolved", () => {
  it("says Oxagen checks them for an organization the resolver runs for", async () => {
    await renderRoles(readOk(catalog));
    const line = screen
      .getByRole("region", { name: "Roles" })
      .querySelector('[data-enforced="true"]');
    expect(line).toHaveTextContent(
      "Oxagen checks these grants on governed calls.",
    );
  });

  it("says a person's grants are recorded and an agent's are enforced, for a tier the resolver skips, and still offers the editor", async () => {
    await renderRoles(
      readOk(
        roleCatalog({
          ...catalog,
          enforcement: { tier: "free", enforced: false },
        }),
      ),
    );
    const line = screen
      .getByRole("region", { name: "Roles" })
      .querySelector('[data-enforced="false"]');
    expect(line).toHaveTextContent("recorded for people, enforced for agents");
    expect(line).toHaveTextContent("free");
    // checkIAM resolves an agent principal BEFORE the tier fast-path
    // (packages/iam/src/check-iam.ts), so the older wording — every governed
    // action allowed whatever a role says — was false for exactly the roles
    // this page edits.
    expect(line).toHaveTextContent("checked on every tier");
    // No control on this page is gated on a tier (maintainer decision, 2026-09-15).
    expect(
      screen.getByRole("button", { name: "Create role" }),
    ).toBeInTheDocument();
  });
});

describe("empty", () => {
  it("says so in place of the table", async () => {
    await renderRoles(readOk(roleCatalog({ roles: [] })));
    expect(
      screen.getByText("This organization has no roles."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("a viewer who cannot write", () => {
  it("names who can and offers no control (negative)", async () => {
    await renderRoles(readOk(catalog), "member");
    expect(
      screen.getByText("An owner or an admin makes these changes."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("a read that did not list", () => {
  it("denied: says which permission is needed, keeps the tabs and lists nothing (negative)", async () => {
    await renderRoles({
      ok: false,
      reason: "denied",
      permission: "org.admin",
    });
    expect(screen.getByText(/org.admin/)).toHaveAttribute(
      "data-reason",
      "denied",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByRole("navigation", { name: "Organization" }),
    ).toBeInTheDocument();
  });

  it("error: names the code and lists nothing (negative)", async () => {
    await renderRoles(readError("control_plane_unavailable", 503));
    expect(screen.getByText(/control_plane_unavailable/)).toHaveAttribute(
      "data-reason",
      "error",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });
});
