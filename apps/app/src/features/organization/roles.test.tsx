// @vitest-environment jsdom
// Organization › Roles (pages/organization-roles.md): the Roles panel with its
// store badge and Create role, the Kind, Scope and Origin filters, one row per
// role with its kind, scope, permission chips ("+N more" past four), Held by
// and Origin, View or Edit, Duplicate and Delete (disabled for a built-in or a
// held role), the note, and the line that says whether Oxagen resolves these
// grants for this organization's tier. Beside them, the IdP group mappings
// over org.sso, which have no other home. Every render is checked with axe.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoleCatalog, SsoSettings } from "@/data/contracts/org";
import type { Read } from "@/data/read";
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
vi.mock("./actions", () => ({
  createRole: vi.fn(),
  deleteRole: vi.fn(),
  setRolePermissions: vi.fn(),
}));
vi.mock("./sso-actions", () => ({ setSsoGroupRoles: vi.fn() }));

const { readOk } = await import("@/data/read");
const { permissionEntry, roleCatalog, roleRow, ssoProvider, ssoSettings } =
  await import("./organization.builders");
const { RolesTab } = await import("./roles");

afterEach(cleanup);

const catalog: RoleCatalog = roleCatalog({
  roles: [
    roleRow({
      permissions: [
        "run.read",
        "budget.set",
        "agent.read",
        "agent.register",
        "agent.suspend",
        "steering.read",
      ],
    }),
    roleRow({
      id: "rol_9z8y7x6w5v4t3s2r1q0p9n",
      name: "org.owner",
      description: "everything, including the data plane and funding",
      scope: "org",
      kind: "human",
      builtIn: true,
      permissions: ["org.*"],
      heldBy: 2,
      createdBy: null,
    }),
    roleRow({
      id: "rol_free00000000000000000",
      name: "agent.finance.pay",
      heldBy: 0,
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

async function renderRoles(
  value: RoleCatalog = catalog,
  sso: Read<SsoSettings> = readOk(ssoSettings({ providers: [] })),
) {
  const view = render(
    <IntlProvider>
      <RolesTab org="acme" catalog={value} sso={sso} />
    </IntlProvider>,
  );
  await expectNoAxe(view.container);
  return view;
}

function rowOf(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-row="${id}"]`);
  if (row === null) throw new Error(`no row ${id}`);
  return row;
}

describe("the Roles panel", () => {
  it("carries the store badge, the gold Create role and the three filters", async () => {
    await renderRoles();
    const panel = screen.getByRole("region", { name: "Roles" });
    expect(within(panel).getByText("postgres · iam")).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", { name: "Create role" }),
    ).toHaveClass("bg-button-primary-bg");
    for (const filter of ["Kind", "Scope", "Origin"]) {
      expect(within(panel).getByLabelText(filter)).toBeInTheDocument();
    }
    expect(within(panel).getByLabelText("Rows")).toBeInTheDocument();
  });

  it("names the columns in the design's order", async () => {
    await renderRoles();
    const headers = screen
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers.slice(0, 6)).toEqual([
      "Role",
      "Kind",
      "Scope",
      "Permissions",
      "Held by",
      "Origin",
    ]);
  });

  it("prints four permission chips and folds the rest into +N more", async () => {
    await renderRoles();
    const row = rowOf("rol_7k2m9q4x8r1t5v3w6y0z2a");
    expect(row).toHaveTextContent("run.read");
    expect(row).toHaveTextContent("agent.register");
    expect(row).not.toHaveTextContent("agent.suspend");
    expect(row).toHaveTextContent("+2 more");
  });

  it("says who holds a role in its own unit, or nobody", async () => {
    await renderRoles();
    expect(rowOf("rol_7k2m9q4x8r1t5v3w6y0z2a")).toHaveTextContent("2 agents");
    expect(rowOf("rol_9z8y7x6w5v4t3s2r1q0p9n")).toHaveTextContent("2 people");
    expect(rowOf("rol_free00000000000000000")).toHaveTextContent("nobody");
  });

  it("prints built-in, or who created a custom role and when", async () => {
    await renderRoles();
    expect(rowOf("rol_9z8y7x6w5v4t3s2r1q0p9n")).toHaveTextContent("built-in");
    expect(rowOf("rol_7k2m9q4x8r1t5v3w6y0z2a")).toHaveTextContent(
      "Priya Natarajan · Aug 30, 2026",
    );
  });

  it("offers View on a built-in role and Edit on a custom one, Duplicate on both", async () => {
    await renderRoles();
    const builtIn = rowOf("rol_9z8y7x6w5v4t3s2r1q0p9n");
    const custom = rowOf("rol_7k2m9q4x8r1t5v3w6y0z2a");
    expect(within(builtIn).getByRole("button", { name: "View" })).toBeEnabled();
    expect(within(builtIn).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(custom).getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(
      within(builtIn).getByRole("button", { name: "Duplicate" }),
    ).toBeEnabled();
  });

  it("disables Delete on a built-in or held role and offers it on a free one (negative)", async () => {
    await renderRoles();
    expect(
      within(rowOf("rol_9z8y7x6w5v4t3s2r1q0p9n")).getByRole("button", {
        name: "Delete: Built-in roles cannot be deleted",
      }),
    ).toBeDisabled();
    expect(
      within(rowOf("rol_7k2m9q4x8r1t5v3w6y0z2a")).getByRole("button", {
        name: "Delete: Reassign the 2 holders first",
      }),
    ).toBeDisabled();
    expect(
      within(rowOf("rol_free00000000000000000")).getByRole("button", {
        name: "Delete",
      }),
    ).toBeEnabled();
  });

  it("filters by kind", async () => {
    await renderRoles();
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "human");
    expect(document.querySelectorAll("[data-row]")).toHaveLength(1);
    expect(rowOf("rol_9z8y7x6w5v4t3s2r1q0p9n")).toBeInTheDocument();
  });

  it("carries the note beneath the table", async () => {
    await renderRoles();
    expect(
      screen.getByText(/A role is a permission set, nothing more\./),
    ).toBeInTheDocument();
  });

  it("says so in place of the table when the organization has no role", async () => {
    await renderRoles(roleCatalog({ roles: [] }));
    expect(
      screen.getByText("This organization has no roles."),
    ).toBeInTheDocument();
    expect(document.querySelectorAll("[data-row]")).toHaveLength(0);
  });

  it("lists each creator and date in the Origin filter, then built-in", async () => {
    await renderRoles();
    const origin = screen.getByLabelText("Origin");
    const options = within(origin)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options[0]).toBe("All · Origin");
    expect(options).toContain("Priya Natarajan · Aug 30, 2026");
    expect(options.at(-1)).toBe("built-in");
    expect(options).not.toContain("custom");
  });

  it("narrows the roles to one creator's", async () => {
    await renderRoles();
    await userEvent.selectOptions(
      screen.getByLabelText("Origin"),
      "Priya Natarajan · Aug 30, 2026",
    );
    expect(rowOf("rol_7k2m9q4x8r1t5v3w6y0z2a")).toBeInTheDocument();
    expect(
      document.querySelector('[data-row="rol_9z8y7x6w5v4t3s2r1q0p9n"]'),
    ).toBeNull();
  });

  it("links the Single sign-on page from the IdP group mappings", async () => {
    await renderRoles();
    expect(screen.getByTestId("sso-settings-link")).toHaveAttribute(
      "href",
      "/acme/sso",
    );
  });
});

describe("whether these grants are resolved", () => {
  it("says Oxagen checks them for an organization the resolver runs for", async () => {
    await renderRoles();
    expect(document.querySelector('[data-enforced="true"]')).toHaveTextContent(
      "Oxagen checks these grants on governed calls.",
    );
  });

  it("says a person's grants are recorded and an agent's enforced on a tier the resolver skips, and still offers the editor", async () => {
    await renderRoles(
      roleCatalog({
        ...catalog,
        enforcement: { tier: "free", enforced: false },
      }),
    );
    const line = document.querySelector('[data-enforced="false"]');
    expect(line).toHaveTextContent("recorded for people, enforced for agents");
    expect(line).toHaveTextContent("checked on every tier");
    // No control on this page is gated on a tier (maintainer decision, 2026-09-15).
    expect(
      screen.getByRole("button", { name: "Create role" }),
    ).toBeInTheDocument();
  });
});

describe("IdP group mappings", () => {
  it("keeps the heading's subtext to one sentence and puts the rules in a note", async () => {
    await renderRoles();
    const section = screen.getByRole("region", { name: "IdP group mappings" });
    const heading = within(section).getByRole("heading", {
      name: "IdP group mappings",
    });
    expect(heading.nextElementSibling).toHaveTextContent(
      /^Map each identity provider group to an organization role\.$/,
    );
    expect(
      within(section).getByTestId("sso-group-mappings-rules"),
    ).toHaveTextContent(
      "When a person's groups match more than one row, the highest role wins.",
    );
  });

  it("points to Single sign-on when the organization has no provider", async () => {
    await renderRoles();
    const section = screen.getByRole("region", { name: "IdP group mappings" });
    expect(
      within(section).getByRole("link", {
        name: "Add one on the Single sign-on page.",
      }),
    ).toHaveAttribute("href", "/acme/sso");
  });

  it("offers one editor per provider, with the mapped rows", async () => {
    await renderRoles(
      catalog,
      readOk(ssoSettings({ providers: [ssoProvider()] })),
    );
    const section = screen.getByRole("region", { name: "IdP group mappings" });
    expect(
      within(section).getByRole("textbox", { name: "Group name, row 1" }),
    ).toHaveValue("oxagen-admins");
  });

  it("says a refused SSO read in its own section and keeps the roles (negative)", async () => {
    await renderRoles(catalog, {
      ok: false,
      reason: "denied",
      permission: "list_sso_providers",
    });
    const section = screen.getByRole("region", { name: "IdP group mappings" });
    expect(within(section).getByText(/list_sso_providers/)).toHaveAttribute(
      "data-reason",
      "denied",
    );
    expect(screen.getByRole("region", { name: "Roles" })).toBeInTheDocument();
  });
});
