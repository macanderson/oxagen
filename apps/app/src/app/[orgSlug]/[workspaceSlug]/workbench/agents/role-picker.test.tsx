// @vitest-environment jsdom
/**
 * role-picker.test.tsx — Access-step role picker behavior: the three system
 * roles render with intent descriptions and grant counts, selection is a
 * radiogroup owned by the caller, delegation-ceiling-blocked options are
 * disabled (selection impossible) with the explanation reachable, the
 * degraded states (load error, tier hint, no custom roles) render honestly,
 * and the current role is badged.
 *
 * `@/components/ui/tooltip` is mocked to a plain stand-in (established repo
 * pattern — the Base UI popup portals and is tested in packages/ui).
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRoleOption } from "@/lib/workbench/agent-roles";
import { RolePicker, roleTestId } from "./role-picker";

afterEach(cleanup);

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  TooltipPopup: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));

function option(overrides: Partial<AgentRoleOption>): AgentRoleOption {
  return {
    roleName: "Agent Contributor",
    description: "Standard worker.",
    isSystemDefault: true,
    scopeKind: "org",
    grants: [
      { capability: "graph.search", effect: "allow" },
      { capability: "repo.pr.open", effect: "require_approval" },
      { capability: "secret.reveal", effect: "deny" },
    ],
    grantsKnown: true,
    resourceScope: { mcp: { rules: [{ pattern: "*", effect: "ask" }] } },
    withinCeiling: true,
    exceededCapabilities: [],
    ...overrides,
  };
}

const SYSTEM_OPTIONS: AgentRoleOption[] = [
  option({ roleName: "Agent Observer", description: "Read/answer only." }),
  option({ roleName: "Agent Contributor", description: "Standard worker." }),
  option({ roleName: "Agent Operator", description: "Trusted automation." }),
];

const baseProps = {
  options: SYSTEM_OPTIONS,
  value: "Agent Contributor",
  onChange: () => {},
  customRolesAvailable: false,
  rolesError: null,
  assignedRoleName: null,
};

describe("roleTestId", () => {
  it("slugs a role name into a stable testid fragment", () => {
    expect(roleTestId("Agent Contributor")).toBe("agent-contributor");
    expect(roleTestId("Custom: Release Ops!")).toBe("custom-release-ops");
  });
});

describe("RolePicker", () => {
  it("renders the three system roles with intent descriptions and the selection checked", () => {
    render(<RolePicker {...baseProps} />);

    const group = screen.getByRole("radiogroup", { name: /agent role/i });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);

    expect(screen.getByText("Read/answer only.")).toBeDefined();
    expect(screen.getByText("Trusted automation.")).toBeDefined();

    const selected = screen.getByTestId("role-option-agent-contributor");
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(
      screen
        .getByTestId("role-option-agent-observer")
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("shows grant counts per role and reports unknown grants honestly", () => {
    render(
      <RolePicker
        {...baseProps}
        options={[
          ...SYSTEM_OPTIONS.slice(0, 2),
          option({
            roleName: "Agent Operator",
            grants: [],
            grantsKnown: false,
          }),
        ]}
      />,
    );

    const counts = screen.getByTestId("role-grant-counts-agent-contributor");
    expect(counts.textContent).toContain("1 allowed");
    expect(counts.textContent).toContain("1 need approval");
    expect(counts.textContent).toContain("1 denied");

    expect(screen.getByText(/grant details unavailable/i)).toBeDefined();
  });

  it("selection calls onChange; a click on the selected role is a no-op change to the same value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RolePicker {...baseProps} onChange={onChange} />);

    await user.click(screen.getByTestId("role-option-agent-operator"));
    expect(onChange).toHaveBeenCalledWith("Agent Operator");
  });

  it("delegation-ceiling-blocked roles are disabled and cannot be selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RolePicker
        {...baseProps}
        onChange={onChange}
        options={[
          SYSTEM_OPTIONS[0]!,
          SYSTEM_OPTIONS[1]!,
          option({
            roleName: "Agent Operator",
            withinCeiling: false,
            exceededCapabilities: ["repo.pr.open", "secret.reveal"],
          }),
        ]}
      />,
    );

    const blocked = screen.getByTestId("role-option-agent-operator");
    expect((blocked as HTMLButtonElement).disabled).toBe(true);

    await user.click(blocked);
    expect(onChange).not.toHaveBeenCalled();

    // The explanation names the offending capabilities.
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toMatch(/cannot delegate/i);
    expect(tooltip.textContent).toContain("repo.pr.open");
  });

  it("renders the load-error state with the degraded-data explanation", () => {
    render(<RolePicker {...baseProps} rolesError="kernel unavailable" />);
    const alert = screen.getByTestId("agent-role-error");
    expect(alert.textContent).toContain("kernel unavailable");
    // System roles still render from their built-in definitions.
    expect(screen.getByTestId("role-option-agent-observer")).toBeDefined();
  });

  it("shows the tier hint when custom roles are unavailable, the empty hint otherwise", () => {
    const { unmount } = render(<RolePicker {...baseProps} />);
    expect(screen.getByTestId("agent-role-custom-tier-hint")).toBeDefined();
    unmount();

    render(<RolePicker {...baseProps} customRolesAvailable={true} />);
    expect(screen.getByTestId("agent-role-custom-empty")).toBeDefined();
  });

  it("lists custom roles under their own heading and badges the current role", () => {
    render(
      <RolePicker
        {...baseProps}
        customRolesAvailable={true}
        assignedRoleName="Release Ops"
        value="Release Ops"
        options={[
          ...SYSTEM_OPTIONS,
          option({
            roleName: "Release Ops",
            description: "Ships releases.",
            isSystemDefault: false,
            resourceScope: null,
          }),
        ]}
      />,
    );

    expect(screen.getByText("Custom roles")).toBeDefined();
    const custom = screen.getByTestId("role-option-release-ops");
    expect(custom.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("role-current-release-ops")).toBeDefined();
  });

  it("disables every option when the picker is disabled (read-only builder)", () => {
    render(<RolePicker {...baseProps} disabled />);
    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
