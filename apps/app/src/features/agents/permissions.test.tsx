// @vitest-environment jsdom
// The Permissions tab drawn on its own (permissions.tsx), for the states the
// page test in agent.test.tsx does not reach: no role held, a role the
// catalogue does not list or could not be read, a role that expires, the
// revoke control for an Owner and Admin and nobody on a retired identity,
// per-run and per-day ceilings the definition file names or cannot, the
// highest priced run against the per-run ceiling, and an agent that holds a
// mandate. Axe runs after every test (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "@/data/contracts/agents";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateList, mandateRow } from "@/test/mandate-views";
import {
  agentDetail,
  committedDefinition,
  roleCatalog,
  runRow,
  spendBudgets,
  toolbelt,
} from "./agents.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  readAssignableRoles: vi.fn(),
  assignAgentRole: vi.fn(),
  revokeAgentRole: vi.fn(),
  requestMandate: vi.fn(),
}));

const { PermissionsSection } = await import("./permissions");

type Props = ComponentProps<typeof PermissionsSection>;
type Role = AgentDetail["roles"][number];

const PLACE = { org: "acme", ws: "core-platform", agent: "release-bot" };

/** A definition file whose `[budget]` table holds what a test hands it. */
function withBudget(budget: string) {
  return agentDetail({
    definition: committedDefinition(
      `schema = "agent-definition/v0.1"\nslug = "release-bot"\n${budget}\n`,
    ),
  });
}

function renderPermissions(overrides: Partial<Props> = {}) {
  const props: Props = {
    detail: agentDetail({ definition: committedDefinition() }),
    toolbelt: readOk(toolbelt()),
    mandates: mandateList([]),
    roles: roleCatalog(),
    budgets: readOk(spendBudgets()),
    runs: [runRow()],
    operatorName: "Marcus Bell",
    orgRole: "member",
    place: PLACE,
    ...overrides,
  };
  render(
    <IntlProvider>
      <PermissionsSection {...props} />
    </IntlProvider>,
  );
}

const region = (name: string) => screen.getByRole("region", { name });
const perRunMeter = () => {
  const label = within(region("Budgets")).getByText("Per run");
  const meter = label.closest("div");
  if (meter === null) throw new Error("no per-run meter");
  return meter;
};

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Permissions › roles", () => {
  it("says no role is held and names the operator by id when no run names them (negative)", () => {
    renderPermissions({
      detail: agentDetail({ roles: [] }),
      operatorName: null,
    });
    const roles = region("Roles");
    expect(roles).toHaveTextContent(
      "Rolesnone held. It can reach nothing but its own run channel.",
    );
    const wire = within(roles).getByRole("list", {
      name: "How the effective permission is computed",
    });
    expect(wire).toHaveTextContent("usr_marcusbell");
  });

  it("names the operator node by its role word when no operator is recorded (negative)", () => {
    renderPermissions({
      detail: agentDetail({ identity: { operatorId: null } }),
      operatorName: null,
    });
    const wire = within(region("Roles")).getByRole("list", {
      name: "How the effective permission is computed",
    });
    expect(within(wire).getAllByText("operator")).toHaveLength(2);
  });

  it("says a role's permissions are not recorded when the catalogue was not read or does not list it (negative)", () => {
    renderPermissions({ roles: null });
    expect(screen.getByTestId("agent-role")).toHaveTextContent("not recorded");
    cleanup();
    renderPermissions({ roles: readError("iam_unavailable", 503) });
    expect(screen.getByTestId("agent-role")).toHaveTextContent("not recorded");
    cleanup();
    const role: Role = {
      id: "rol_gone",
      name: "Gone role",
      scopeKind: "org",
      assignedAt: "2026-09-02T10:00:00.000Z",
      expiresAt: null,
    };
    renderPermissions({ detail: agentDetail({ roles: [role] }) });
    const held = screen.getByTestId("agent-role");
    expect(held).toHaveTextContent("not recorded");
    expect(held).toHaveTextContent("organization role since");
  });

  it("finds a role in the catalogue by name when its id differs, and says when it expires", () => {
    const role: Role = {
      id: "rol_ci_v2",
      name: "CI writer",
      scopeKind: "workspace",
      assignedAt: "2026-09-02T10:00:00.000Z",
      expiresAt: "2026-12-01T10:00:00.000Z",
    };
    renderPermissions({ detail: agentDetail({ roles: [role] }) });
    const held = screen.getByTestId("agent-role");
    expect(held).toHaveTextContent("repo.write · pr.open");
    expect(held).toHaveTextContent("expires");
  });

  it("offers Assign and a Revoke per role to an Admin", () => {
    renderPermissions({ orgRole: "admin" });
    const roles = region("Roles");
    expect(
      within(roles).getByRole("button", { name: "Assign a role" }),
    ).toBeVisible();
    expect(
      within(screen.getByTestId("agent-role")).getByRole("button", {
        name: /CI writer/,
      }),
    ).toBeVisible();
  });

  it("offers an Owner no role writes on a retired identity (negative)", () => {
    renderPermissions({
      orgRole: "owner",
      detail: agentDetail({ identity: { status: "retired" } }),
    });
    expect(screen.queryByRole("button", { name: "Assign a role" })).toBeNull();
    expect(
      within(screen.getByTestId("agent-role")).queryByRole("button"),
    ).toBeNull();
  });

  it("says the belt was not read and the ceiling is not recorded when the belt read failed (negative)", () => {
    renderPermissions({ toolbelt: readError("toolbelt_unavailable", 503) });
    expect(region("Roles")).toHaveTextContent("belt not read");
    expect(region("Budgets")).toHaveTextContent(
      "Delegation ceilingnot recorded",
    );
  });

  it("counts the mandates in effect when the agent holds one", () => {
    renderPermissions({ mandates: mandateList([mandateRow()]) });
    expect(region("Roles")).toHaveTextContent(
      "Can move money1 mandateand only inside it",
    );
  });

  it("says whether it can move money is not recorded when the mandates were not read (negative)", () => {
    renderPermissions({ mandates: readError("mandates_unavailable", 503) });
    expect(region("Roles")).toHaveTextContent("Can move moneynot recorded");
  });
});

describe("Permissions › ceilings from the definition file", () => {
  it("prints the per-run and per-day ceilings the file names", () => {
    renderPermissions({
      detail: withBudget(
        "[budget]\nper_run_micros = 4000000\nper_day_micros = 20000000",
      ),
    });
    expect(region("Roles")).toHaveTextContent("$4.00 USD");
    expect(region("Roles")).toHaveTextContent("$20.00 USD");
    const budgets = region("Budgets");
    expect(budgets).toHaveTextContent("Per day$20.00");
    expect(budgets).toHaveTextContent(
      "kept in the definition file; nothing enforces it yet",
    );
    expect(
      within(budgets).queryByText(
        "No per-day ceiling is recorded for this agent, and nothing would enforce one yet.",
      ),
    ).toBeNull();
  });

  it.each([
    ["no definition file", null],
    ["a budget that is not a table", "budget = 5"],
    ["a budget that is a list", "budget = [1, 2]"],
    ["a ceiling that is not a number", 'budget = { per_run_micros = "lots" }'],
    ["a negative ceiling", "budget = { per_run_micros = -1 }"],
    ["a ceiling that is not whole", "budget = { per_run_micros = 2.5 }"],
    ["a file the parser refuses", "budget = { per_run_micros = "],
  ])("says the ceilings are not recorded for %s (negative)", (_, budget) => {
    renderPermissions({
      detail:
        budget === null
          ? agentDetail({ definition: null })
          : withBudget(budget),
    });
    expect(region("Roles")).toHaveTextContent("Spend ceilingnot recorded");
    expect(perRunMeter()).toHaveTextContent("Per runnot recorded");
    expect(region("Budgets")).toHaveTextContent(
      "No per-day ceiling is recorded for this agent, and nothing would enforce one yet.",
    );
  });
});

describe("Permissions › budgets", () => {
  it("measures the highest priced run against the per-run ceiling, in the critical hue past 80%", () => {
    renderPermissions({
      runs: [
        runRow({ id: "arun_1" }),
        runRow({
          id: "arun_2",
          cost: { micros: "2400000", currency: "USD", basis: null },
        }),
        runRow({ id: "arun_3", cost: null }),
      ],
    });
    const meter = perRunMeter();
    // The definition's per-run ceiling is $2.50; the highest run is $4.13.
    expect(meter).toHaveTextContent("highest run on the newest page $4.13");
    expect(meter).toHaveTextContent("basis: gateway_observed");
    expect(meter.querySelector(".bg-critical")).not.toBeNull();
  });

  it("draws the bar in the calm hue at or under 80%, and says a missing basis is not recorded", () => {
    renderPermissions({
      runs: [
        runRow({
          cost: { micros: "1000000", currency: "USD", basis: null },
        }),
      ],
    });
    const meter = perRunMeter();
    expect(meter).toHaveTextContent("basis: not recorded");
    expect(meter.querySelector(".bg-success")).not.toBeNull();
  });

  it("draws no bar and says no run is priced when none of the runs carries a cost (negative)", () => {
    renderPermissions({ runs: [runRow({ cost: null })] });
    const meter = perRunMeter();
    expect(meter).toHaveTextContent(
      "no priced run of this agent on the newest page of runs",
    );
    expect(meter.querySelector(".bg-success, .bg-critical")).toBeNull();
  });

  it("draws no bar against a ceiling the file does not name, though a run is priced (negative)", () => {
    renderPermissions({ detail: agentDetail({ definition: null }) });
    const meter = perRunMeter();
    expect(meter).toHaveTextContent("highest run on the newest page");
    expect(meter.querySelector(".bg-success, .bg-critical")).toBeNull();
  });

  it("draws no ceilings table when the tab read no budgets (negative)", () => {
    renderPermissions({ budgets: null });
    expect(
      screen.queryByRole("region", { name: "Ceilings above this agent" }),
    ).toBeNull();
  });
});
