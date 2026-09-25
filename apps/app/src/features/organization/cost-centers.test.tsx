// @vitest-environment jsdom
// Organization › Cost centers (ADR-142): the label list with its counts, each
// live workspace's cost center, the writes an owner or billing member is
// offered and a member is not, the empty line, and a failed read. Every state
// is checked with axe.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CostCenterList, WorkspaceList } from "@/data/contracts/org";
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

const { readError, readOk } = await import("@/data/read");
const { orgSource, workspaceRow } = await import("./organization.builders");
const { CostCenters, CostCentersView } = await import("./cost-centers");
const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");

afterEach(() => {
  cleanup();
});

/** The table row a cell's text sits in. */
function rowOf(element: HTMLElement): HTMLElement {
  const row = element.closest("tr");
  if (row === null) throw new Error("the text is not in a table row");
  return row;
}

const centers: CostCenterList = {
  costCenters: [
    {
      id: "ccn_0a1b2c3d4e5f6g7h8j9k0m",
      label: "ENG-1001",
      description: "Platform engineering",
      agents: 2,
      workspaces: 1,
    },
    {
      id: "ccn_9z8y7x6w5v4t3s2r1q0p9n",
      label: "MKT-2002",
      description: null,
      agents: 0,
      workspaces: 0,
    },
  ],
};

const workspaces: WorkspaceList = {
  orgId: "org_7k2m9q4x8r1t5v3w6y0z2a",
  orgAvatarUrl: null,
  workspaces: [
    workspaceRow({ costCenter: "ENG-1001" }),
    workspaceRow({
      id: "wrk_9z8y7x6w5v4t3s2r1q0p9n",
      slug: "research",
      name: "Research",
    }),
    workspaceRow({
      id: "wrk_1z8y7x6w5v4t3s2r1q0p9n",
      slug: "old",
      name: "Old",
      archivedAt: "2026-09-01T08:00:00.000Z",
    }),
  ],
};

async function renderView(
  props: Partial<Parameters<typeof CostCentersView>[0]> = {},
) {
  const view = render(
    <IntlProvider>
      <CostCentersView
        org="acme"
        canEdit
        centers={readOk(centers)}
        workspaces={readOk(workspaces)}
        {...props}
      />
    </IntlProvider>,
  );
  await expectNoAxe(view.container);
  return view;
}

describe("Cost centers", () => {
  it("lists each label with the agents and workspaces that name it", async () => {
    await renderView();
    const labels = screen.getByRole("table", { name: "Cost centers" });
    const eng = rowOf(within(labels).getByText("ENG-1001"));
    expect(within(eng).getByText("Platform engineering")).toBeDefined();
    expect(within(eng).getByText("2")).toBeDefined();
    const mkt = rowOf(within(labels).getByText("MKT-2002"));
    expect(within(mkt).getByText("No description")).toBeDefined();
    expect(
      within(labels).getAllByRole("button", { name: "Delete" }),
    ).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Add a cost center" }),
    ).toBeDefined();
  });

  it("shows each live workspace's cost center and leaves archived ones out", async () => {
    await renderView();
    const table = screen.getByRole("table", { name: "Workspace cost centers" });
    const core = rowOf(within(table).getByText("Core platform"));
    expect(within(core).getByText("ENG-1001")).toBeDefined();
    const research = rowOf(within(table).getByText("Research"));
    expect(within(research).getByText("None")).toBeDefined();
    expect(within(table).queryByText("Old")).toBeNull();
    expect(
      within(table).getAllByRole("button", { name: "Change" }),
    ).toHaveLength(2);
  });

  it("offers a member no write", async () => {
    await renderView({ canEdit: false });
    expect(
      screen.queryByRole("button", { name: "Add a cost center" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("says so when the organization has no cost centers", async () => {
    await renderView({ centers: readOk({ costCenters: [] }) });
    expect(
      screen.getByText("This organization has no cost centers."),
    ).toBeDefined();
  });

  it("keeps the workspaces table when the label read fails", async () => {
    await renderView({ centers: readError("unavailable", 503) });
    expect(
      screen.getByRole("table", { name: "Workspace cost centers" }),
    ).toBeDefined();
    expect(screen.queryByRole("table", { name: "Cost centers" })).toBeNull();
  });
});

describe("Cost centers section", () => {
  it.each([
    ["billing", true],
    ["member", false],
  ] as const)(
    "reads both lists for a %s and offers writes: %s",
    async (orgRole, writes) => {
      const ctx = unsafeMint(OrgCtx, {
        userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        orgId: "7a000000-0000-4000-8000-0000000000a1",
        orgSlug: "acme",
        orgName: "Acme Robotics",
        orgRole,
      });
      const { source, calls } = orgSource({
        costCenters: readOk(centers),
        workspaces: readOk(workspaces),
      });
      const view = render(
        <IntlProvider>{await CostCenters({ ctx, source })}</IntlProvider>,
      );
      expect(calls.costCenters).toEqual([[ctx]]);
      expect(calls.workspaces).toEqual([[ctx]]);
      expect(
        screen.queryByRole("button", { name: "Add a cost center" }) !== null,
      ).toBe(writes);
      await expectNoAxe(view.container);
    },
  );
});
