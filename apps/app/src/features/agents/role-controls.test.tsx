// @vitest-environment jsdom
// The two role writes on the identity tab: Assign reads the catalogue when it
// opens and offers only the roles an agent may hold, Revoke names the role it
// is about to detach, and both reload the agent's page once the write answers.
// A refusal is named in the dialog and nothing navigates, which is what a
// person who lacks the organization role sees.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, assignAgentRole, readAssignableRoles, revokeAgentRole } =
  vi.hoisted(() => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    assignAgentRole: vi.fn(),
    readAssignableRoles: vi.fn(),
    revokeAgentRole: vi.fn(),
  }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  assignAgentRole,
  readAssignableRoles,
  revokeAgentRole,
}));

const { AssignRole, RevokeRole } = await import("./role-controls");

const TARGET = {
  org: "acme",
  ws: "core-platform",
  agentId: "agt_releasebot",
  agentSlug: "release-bot",
};
const HERE = routes.agent("acme", "core-platform", "release-bot");

const OFFER = {
  roles: [
    { name: "Agent Observer", scope: "org" as const, builtIn: true },
    { name: "Release deputy", scope: "workspace" as const, builtIn: false },
  ],
  enforced: true,
  tier: "enterprise",
  more: false,
};

function renderAssign() {
  render(
    <IntlProvider>
      <AssignRole {...TARGET} />
    </IntlProvider>,
  );
}

function renderRevoke(roleName = "Agent Operator") {
  render(
    <IntlProvider>
      <RevokeRole {...TARGET} roleName={roleName} />
    </IntlProvider>,
  );
}

/** Opens the assign dialog and waits for the catalogue read to settle. */
async function openAssign() {
  await userEvent.click(screen.getByRole("button", { name: "Assign a role" }));
  return screen.getByTestId("assign-role");
}

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  assignAgentRole.mockReset();
  readAssignableRoles.mockReset();
  revokeAgentRole.mockReset();
  readAssignableRoles.mockResolvedValue({ ok: true, value: OFFER });
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("AssignRole", () => {
  it("reads the catalogue when it opens and assigns the chosen role", async () => {
    assignAgentRole.mockResolvedValue({
      ok: true,
      value: { roleName: "Release deputy", alreadyAssigned: false },
    });
    renderAssign();
    expect(readAssignableRoles).not.toHaveBeenCalled();
    const dialog = await openAssign();
    expect(readAssignableRoles).toHaveBeenCalledWith("acme", "core-platform");
    const picker = await within(dialog).findByLabelText("Role");
    await userEvent.selectOptions(picker, "Release deputy");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Assign" }),
    );
    expect(assignAgentRole).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_releasebot",
      "Release deputy",
    );
    expect(router.replace).toHaveBeenCalledWith(HERE);
    expect(screen.queryByTestId("assign-role")).toBeNull();
  });

  it("marks a seeded role and offers no role an agent may not hold", async () => {
    renderAssign();
    const dialog = await openAssign();
    const picker = await within(dialog).findByLabelText("Role");
    expect(
      within(picker)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Agent Observer (seeded)", "Release deputy"]);
  });

  it("says the catalogue is being read before it answers", async () => {
    let answer = (_value: unknown) => {};
    readAssignableRoles.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    renderAssign();
    const dialog = await openAssign();
    expect(
      within(dialog).getByText("Reading the role catalogue."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Assign" })).toBeNull();
    answer({ ok: true, value: OFFER });
    expect(await within(dialog).findByLabelText("Role")).toBeInTheDocument();
  });

  it("offers nothing to assign when the organization has no agent role (empty)", async () => {
    readAssignableRoles.mockResolvedValue({
      ok: true,
      value: { ...OFFER, roles: [] },
    });
    renderAssign();
    const dialog = await openAssign();
    expect(
      await within(dialog).findByText(/no role an agent may hold/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Assign" })).toBeNull();
  });

  it("names a refused catalogue read and offers no picker (negative)", async () => {
    readAssignableRoles.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderAssign();
    const dialog = await openAssign();
    expect(
      await within(dialog).findByTestId("assign-role-catalogue-failure"),
    ).toHaveTextContent("Your organization role does not allow this change.");
    expect(within(dialog).queryByLabelText("Role")).toBeNull();
  });

  // The claim the dialog may make is the one the record backs: below the tier
  // that runs the resolver, an assignment governs nothing yet.
  it("says when the organization's tier does not enforce the role", async () => {
    readAssignableRoles.mockResolvedValue({
      ok: true,
      value: { ...OFFER, enforced: false, tier: "build" },
    });
    renderAssign();
    const dialog = await openAssign();
    expect(
      await within(dialog).findByText(/On the build tier/),
    ).toBeInTheDocument();
  });

  it("says when the catalogue is one page of more roles than it lists", async () => {
    readAssignableRoles.mockResolvedValue({
      ok: true,
      value: { ...OFFER, more: true },
    });
    renderAssign();
    const dialog = await openAssign();
    expect(
      await within(dialog).findByText(/more roles than the 200/),
    ).toBeInTheDocument();
  });

  it("names a denied assignment and stays where it is (negative)", async () => {
    assignAgentRole.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderAssign();
    const dialog = await openAssign();
    await within(dialog).findByLabelText("Role");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Assign" }),
    );
    expect(
      await within(dialog).findByTestId("assign-role-failure"),
    ).toHaveTextContent("Your organization role does not allow this change.");
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("assign-role")).toBeInTheDocument();
  });

  it("names a write that never answered (negative)", async () => {
    assignAgentRole.mockRejectedValue(new Error("socket closed"));
    renderAssign();
    const dialog = await openAssign();
    await within(dialog).findByLabelText("Role");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Assign" }),
    );
    expect(
      await within(dialog).findByTestId("assign-role-failure"),
    ).toHaveTextContent("action_failed");
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("RevokeRole", () => {
  it("names the role it detaches and reloads the page once it has", async () => {
    revokeAgentRole.mockResolvedValue({
      ok: true,
      value: { roleName: "Agent Operator", revoked: true },
    });
    renderRevoke();
    await userEvent.click(
      screen.getByRole("button", { name: "Revoke Agent Operator" }),
    );
    const dialog = screen.getByTestId("revoke-role-Agent Operator");
    expect(dialog).toHaveTextContent(
      "The agent stops holding Agent Operator at its next call.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revoke" }),
    );
    expect(revokeAgentRole).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_releasebot",
      "Agent Operator",
    );
    expect(router.replace).toHaveBeenCalledWith(HERE);
    expect(screen.queryByTestId("revoke-role-Agent Operator")).toBeNull();
  });

  it("names a denied revocation and changes nothing (negative)", async () => {
    revokeAgentRole.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderRevoke();
    await userEvent.click(
      screen.getByRole("button", { name: "Revoke Agent Operator" }),
    );
    const dialog = screen.getByTestId("revoke-role-Agent Operator");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revoke" }),
    );
    expect(
      await within(dialog).findByTestId("revoke-role-Agent Operator-failure"),
    ).toHaveTextContent("Your organization role does not allow this change.");
    expect(router.replace).not.toHaveBeenCalled();
  });
});
