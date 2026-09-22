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
const { workspaceRow } = await import("./organization.builders");
const { CostCentersView } = await import("./cost-centers");

afterEach(() => {
  cleanup();
});

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
    const eng = within(labels).getByText("ENG-1001").closest("tr")!;
    expect(within(eng).getByText("Platform engineering")).toBeDefined();
    expect(within(eng).getByText("2")).toBeDefined();
    const mkt = within(labels).getByText("MKT-2002").closest("tr")!;
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
    const core = within(table).getByText("Core platform").closest("tr")!;
    expect(within(core).getByText("ENG-1001")).toBeDefined();
    const research = within(table).getByText("Research").closest("tr")!;
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
