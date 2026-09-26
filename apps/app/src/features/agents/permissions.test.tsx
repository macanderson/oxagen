// @vitest-environment jsdom
// The Permissions tab drawn on its own (permissions.tsx), for the states the
// page test in agent.test.tsx does not reach: no role held, a role the
// catalogue does not list or could not be read, a role that expires, the
// revoke control for an Owner and Admin and nobody on a retired identity, the
// agent's own ceilings that no read returns yet (ADR-198), the highest priced
// run, and an agent that holds a mandate. Axe runs after every test (INV-26).
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

function renderPermissions(overrides: Partial<Props> = {}) {
  const props: Props = {
    detail: agentDetail(),
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

  it("names the agent as this agent in the denial chain when it has no agent key (negative)", () => {
    // An Owner reads the whole ledger, so the empty state carries the chain.
    renderPermissions({
      orgRole: "owner",
      detail: agentDetail({ identity: { agentKey: null } }),
    });
    expect(screen.getByTestId("denial-chain")).toHaveTextContent("this agent");
    expect(screen.getByTestId("denial-chain")).not.toHaveTextContent(
      "acme.core.release-bot",
    );
  });

  it("says whether it can move money is not recorded when the mandates were not read (negative)", () => {
    renderPermissions({ mandates: readError("mandates_unavailable", 503) });
    expect(region("Roles")).toHaveTextContent("Can move moneynot recorded");
  });
});

describe("Permissions › the agent's own ceilings", () => {
  const LIMITS: AgentDetail["limits"] = {
    perRun: { micros: "2500000", currency: "USD" },
    perDay: { micros: "40000000", currency: "USD" },
    containmentRequired: false,
    invalid: false,
  };

  it("says a ceiling the active version does not set is not recorded (negative)", () => {
    renderPermissions();
    expect(region("Roles")).toHaveTextContent("Spend ceilingnot recorded");
    expect(perRunMeter()).toHaveTextContent("Per runnot recorded");
    expect(region("Budgets")).toHaveTextContent(
      "The agent's active version sets no per-day ceiling.",
    );
    expect(
      within(region("Budgets")).queryByRole("link", { name: "Set budget" }),
    ).toBeNull();
  });

  it("shows the per-run and per-day ceilings the active version sets (ADR-198)", () => {
    renderPermissions({
      detail: agentDetail({ limits: LIMITS }),
      runs: [
        runRow({ cost: { micros: "1250000", currency: "USD", basis: null } }),
      ],
    });
    expect(region("Roles")).toHaveTextContent("$2.50");
    expect(region("Roles")).toHaveTextContent(
      "per day, set on the agent's active version",
    );
    const meter = perRunMeter();
    expect(meter).toHaveTextContent("Per run$2.50");
    // Half the ceiling: the bar is drawn.
    expect(meter.querySelector(".bg-success, .bg-critical")).not.toBeNull();
    expect(region("Budgets")).toHaveTextContent(
      "Signed to a host that enforces a daily ceiling.",
    );
    expect(region("Budgets")).toHaveTextContent("$40.00");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a config the host cannot read suspends governed actions", () => {
    renderPermissions({
      detail: agentDetail({
        limits: { ...LIMITS, perRun: null, perDay: null, invalid: true },
      }),
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The agent's version config cannot be read, so its host suspends governed actions until the config is fixed.",
    );
  });
});

describe("Permissions › budgets", () => {
  it("names the highest priced run and its basis, and draws no bar without a ceiling", () => {
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
    expect(meter).toHaveTextContent("highest run on the newest page $4.13");
    expect(meter).toHaveTextContent("basis: gateway_observed");
    expect(meter.querySelector(".bg-success, .bg-critical")).toBeNull();
  });

  it("says a missing basis is not recorded", () => {
    renderPermissions({
      runs: [
        runRow({
          cost: { micros: "1000000", currency: "USD", basis: null },
        }),
      ],
    });
    expect(perRunMeter()).toHaveTextContent("basis: not recorded");
  });

  it("says no run is priced when none of the runs carries a cost (negative)", () => {
    renderPermissions({ runs: [runRow({ cost: null })] });
    expect(perRunMeter()).toHaveTextContent(
      "no priced run of this agent on the newest page of runs",
    );
  });

  it("draws no ceilings table when the tab read no budgets (negative)", () => {
    renderPermissions({ budgets: null });
    expect(
      screen.queryByRole("region", { name: "Ceilings above this agent" }),
    ).toBeNull();
  });
});
