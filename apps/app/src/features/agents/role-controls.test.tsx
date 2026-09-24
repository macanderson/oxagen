// @vitest-environment jsdom
// The two role writes: Assign reads the catalogue and the roles the agent
// holds when it opens, offers only the roles an agent may hold with a held one
// marked and disabled, leaves a receipt once the write answers and reloads the
// page when the receipt is closed. Revoke names the role it is about to
// detach and reloads the agent's page once it has. A refusal is named in the
// dialog and nothing navigates, which is what a person who lacks the
// organization role sees.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const {
  router,
  assignAgentRole,
  readAgentRoleNames,
  readAssignableRoles,
  revokeAgentRole,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  assignAgentRole: vi.fn(),
  readAgentRoleNames: vi.fn(),
  readAssignableRoles: vi.fn(),
  revokeAgentRole: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("./actions", () => ({
  assignAgentRole,
  readAgentRoleNames,
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
const HERE = routes.agent("acme", "core-platform", "release-bot", {
  tab: "permissions",
});

const OFFER = {
  roles: [
    {
      name: "Agent Observer",
      description: "Reads runs and records",
      scope: "org" as const,
      builtIn: true,
    },
    {
      name: "Release deputy",
      description: null,
      scope: "workspace" as const,
      builtIn: false,
    },
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
  readAgentRoleNames.mockReset();
  revokeAgentRole.mockReset();
  readAssignableRoles.mockResolvedValue({ ok: true, value: OFFER });
  readAgentRoleNames.mockResolvedValue({ ok: true, value: [] });
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("AssignRole", () => {
  it("reads the catalogue and the held roles when it opens, assigns the chosen role and leaves a receipt", async () => {
    assignAgentRole.mockResolvedValue({
      ok: true,
      value: { roleName: "Release deputy", alreadyAssigned: false },
    });
    renderAssign();
    expect(readAssignableRoles).not.toHaveBeenCalled();
    const dialog = await openAssign();
    expect(readAssignableRoles).toHaveBeenCalledWith("acme", "core-platform");
    expect(readAgentRoleNames).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_releasebot",
    );
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
      "",
    );
    // The design's receipt, in the dialog: the page has not reloaded yet.
    expect(
      await within(dialog).findByTestId("assign-role-receipt"),
    ).toHaveTextContent(
      "Release deputy assigned to release-bot. Recorded with your name; effective at its next call.",
    );
    expect(router.replace).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close" }),
    );
    expect(router.replace).toHaveBeenCalledWith(HERE);
    expect(screen.queryByTestId("assign-role")).toBeNull();
  });

  it("puts Assign in the footer beside Cancel, and draws the Repository row as not backed", async () => {
    renderAssign();
    const dialog = await openAssign();
    await within(dialog).findByLabelText("Role");
    const footer = dialog.querySelector("[data-sheet-footer]");
    if (!(footer instanceof HTMLElement)) throw new Error("no footer");
    expect(
      within(footer)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Assign"]);
    const repository = within(dialog).getByTestId("assign-role-repository");
    expect(repository).toHaveAttribute("data-not-backed");
    expect(repository).toHaveAttribute("data-gap", "#3865");
    expect(repository).toHaveTextContent(
      "RepositoryNo role can be bound to one repository yet (#3865).",
    );
    expect(within(dialog).getByLabelText("Why")).toHaveAttribute(
      "placeholder",
      "Read by the approver and kept in the audit record",
    );
  });

  it("quotes the reason in the receipt, and says an unenforced role governs nothing yet", async () => {
    readAssignableRoles.mockResolvedValue({
      ok: true,
      value: { ...OFFER, enforced: false, tier: "build" },
    });
    assignAgentRole.mockResolvedValue({
      ok: true,
      value: { roleName: "Agent Observer", alreadyAssigned: false },
    });
    renderAssign();
    const dialog = await openAssign();
    await within(dialog).findByLabelText("Role");
    await userEvent.type(within(dialog).getByLabelText("Why"), "Audit prep");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Assign" }),
    );
    expect(
      await within(dialog).findByTestId("assign-role-receipt"),
    ).toHaveTextContent(
      "Agent Observer assigned to release-bot · “Audit prep”. Recorded with your name. It governs nothing until the organization's tier enforces roles.",
    );
  });

  it("says the agent already held the role and reloads nothing (negative)", async () => {
    assignAgentRole.mockResolvedValue({
      ok: true,
      value: { roleName: "Agent Observer", alreadyAssigned: true },
    });
    renderAssign();
    const dialog = await openAssign();
    await within(dialog).findByLabelText("Role");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Assign" }),
    );
    expect(
      await within(dialog).findByTestId("assign-role-receipt"),
    ).toHaveTextContent("release-bot already holds Agent Observer.");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close" }),
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("draws the design's dialog: the key, the agent-kind hint, a Why field it sends, and the operator's ceiling", async () => {
    assignAgentRole.mockResolvedValue({
      ok: true,
      value: { roleName: "Agent Observer", alreadyAssigned: false },
    });
    render(
      <IntlProvider>
        <AssignRole
          {...TARGET}
          agentKey="acme.core.release-bot"
          operatorName="Marcus Bell"
        />
      </IntlProvider>,
    );
    const dialog = await openAssign();
    expect(dialog).toHaveTextContent("acme.core.release-bot");
    await within(dialog).findByLabelText("Role");
    const hint = within(dialog).getByTestId("assign-role-hint");
    expect(hint).toHaveTextContent(
      "Only agent-kind roles are listed. Manage roles",
    );
    expect(
      within(hint).getByRole("link", { name: "Manage roles" }),
    ).toHaveAttribute("href", "/acme/roles");
    expect(within(dialog).getByTestId("assign-role-note")).toHaveTextContent(
      "Effective permission stays roles ∩ Marcus Bell's grants. A role cannot lift an agent above its operator.",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Why"),
      "Reads the September runs",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Assign" }),
    );
    expect(assignAgentRole).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "agt_releasebot",
      "Agent Observer",
      "Reads the September runs",
    );
  });

  it("names no operator in the note when none is recorded", async () => {
    renderAssign();
    const dialog = await openAssign();
    await within(dialog).findByLabelText("Role");
    expect(within(dialog).getByTestId("assign-role-note")).toHaveTextContent(
      "Effective permission stays roles ∩ the operator's grants.",
    );
  });

  it("names each role with what it is for, and marks and disables a role the agent holds", async () => {
    readAgentRoleNames.mockResolvedValue({
      ok: true,
      value: ["Agent Observer"],
    });
    renderAssign();
    const dialog = await openAssign();
    await within(dialog).findByText(
      "Agent Observer · held — Reads runs and records",
    );
    const picker = within(dialog).getByLabelText("Role");
    const options = within(picker).getAllByRole<HTMLOptionElement>("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Agent Observer · held — Reads runs and records",
      "Release deputy",
    ]);
    expect(options.map((option) => option.disabled)).toEqual([true, false]);
    // The picker lands on the first role the agent does not hold.
    expect(picker).toHaveValue("Release deputy");
  });

  it("offers every role unmarked when the held roles cannot be read (negative)", async () => {
    readAgentRoleNames.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    renderAssign();
    const dialog = await openAssign();
    const picker = await within(dialog).findByLabelText("Role");
    expect(
      within(picker)
        .getAllByRole<HTMLOptionElement>("option")
        .map((option) => [option.textContent, option.disabled]),
    ).toEqual([
      ["Agent Observer — Reads runs and records", false],
      ["Release deputy", false],
    ]);
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

describe("Role writes while a dialog is open", () => {
  it("reads the catalogue once, however often the dialog is opened, and the held roles each time", async () => {
    renderAssign();
    let dialog = await openAssign();
    await within(dialog).findByLabelText("Role");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^(Close|Cancel)$/ }),
    );
    dialog = await openAssign();
    await within(dialog).findByLabelText("Role");
    expect(readAssignableRoles).toHaveBeenCalledTimes(1);
    expect(readAgentRoleNames).toHaveBeenCalledTimes(2);
  });

  it("sends one assign however often the form is submitted while it is pending (negative)", async () => {
    assignAgentRole.mockReturnValue(new Promise(() => undefined));
    renderAssign();
    const dialog = await openAssign();
    await within(dialog).findByLabelText("Role");
    const form = dialog.querySelector("form");
    if (form === null) throw new Error("assign form not drawn");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(assignAgentRole).toHaveBeenCalledTimes(1);
  });

  it("sends one revoke however often the form is submitted while it is pending (negative)", async () => {
    revokeAgentRole.mockReturnValue(new Promise(() => undefined));
    renderRevoke();
    await userEvent.click(
      screen.getByRole("button", { name: "Revoke Agent Operator" }),
    );
    const form = screen
      .getByTestId("revoke-role-Agent Operator")
      .querySelector("form");
    if (form === null) throw new Error("revoke form not drawn");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(revokeAgentRole).toHaveBeenCalledTimes(1);
  });

  it("forgets a refused revoke when its dialog is closed and opened again", async () => {
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
    await screen.findByTestId("revoke-role-Agent Operator-failure");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^(Close|Cancel)$/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Revoke Agent Operator" }),
    );
    expect(
      screen.queryByTestId("revoke-role-Agent Operator-failure"),
    ).toBeNull();
  });
});
