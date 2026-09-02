// @vitest-environment jsdom
/**
 * coding-agent-preferences-form.test.tsx — component tests for
 * CodingAgentPreferencesForm.
 *
 * `@/components/ui/select` is mocked — Base UI's Select popup needs
 * pointer-events + floating-ui layout jsdom can't provide (same constraint
 * documented in packages/ui/src/components/select.test.tsx); every SelectItem
 * is rendered as a plain clickable button wired to onValueChange via context,
 * following the established apps/app convention (see e.g.
 * memory-evidence-attach-form.test.tsx).
 *
 * Covers:
 *   (a) Renders "No default" for all three fields when no saved preference
 *       matches a live option.
 *   (b) Resolves a saved repo/environment/agent id to its live selection.
 *   (c) Save sends the resolved (connectionId, owner/repo slug) pair, env id,
 *       and agent id to the action.
 *   (d) Clearing a field back to "No default" sends null for that field.
 *   (e) Action failure surfaces an inline error, never throws.
 */

import * as React from "react";
import {
  render,
  screen,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { RepoOption } from "@/components/chat/repo-selector";
import type { EnvironmentOption } from "@/components/chat/environment-selector";
import type { AgentOption } from "@/components/chat/agent-picker/agent-picker-types";

const { mockAction } = vi.hoisted(() => ({ mockAction: vi.fn() }));

vi.mock("./coding-agent-preferences-actions", () => ({
  updateCodingAgentPreferencesAction: mockAction,
}));

const SelectContext = React.createContext<{
  onValueChange?: (v: string) => void;
}>({});

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange?: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <SelectContext.Provider value={{ onValueChange }}>
      <div data-current-value={value}>{children}</div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({
    children,
    id,
  }: {
    children: React.ReactNode;
    id?: string;
  }) => <div id={id}>{children}</div>,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => {
    const { onValueChange } = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

import { CodingAgentPreferencesForm } from "./coding-agent-preferences-form";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const REPOS: RepoOption[] = [
  {
    key: "con-1::acme/repo-a",
    connectionId: "con-1",
    owner: "acme",
    name: "repo-a",
    defaultBranch: "main",
  },
  {
    key: "con-1::acme/repo-b",
    connectionId: "con-1",
    owner: "acme",
    name: "repo-b",
    defaultBranch: "main",
  },
];
const ENVIRONMENTS: EnvironmentOption[] = [
  { id: "env-1", name: "Sandbox", isDefault: true },
  { id: "env-2", name: "Staging", isDefault: false },
];
const AGENTS: AgentOption[] = [
  {
    agentId: "agt_1",
    slug: "coder",
    name: "Coder",
    description: null,
    agentType: "code",
    isCode: true,
    avatarUrl: null,
    summary: null,
    managed: true,
    toolRefs: [],
  },
];

function baseProps() {
  return {
    orgSlug: "acme",
    workspaceSlug: "main",
    repos: REPOS,
    environments: ENVIRONMENTS,
    agents: AGENTS,
    initialRepoConnectionId: null,
    initialRepoSlug: null,
    initialEnvironmentId: null,
    initialAgentId: null,
  };
}

function fieldScope(label: string) {
  return screen.getByText(label).parentElement as HTMLElement;
}

describe("CodingAgentPreferencesForm", () => {
  it("defaults all three fields to 'No default' when nothing is saved", () => {
    render(<CodingAgentPreferencesForm {...baseProps()} />);
    expect(
      within(fieldScope("Default repository")).getByRole("button", {
        name: "No default",
      }),
    ).toBeInTheDocument();
    expect(
      within(fieldScope("Default environment")).getByRole("button", {
        name: "No default",
      }),
    ).toBeInTheDocument();
    expect(
      within(fieldScope("Default agent")).getByRole("button", {
        name: "No default",
      }),
    ).toBeInTheDocument();
  });

  it("resolves a saved repo/env/agent id that still exists to its live selection", () => {
    render(
      <CodingAgentPreferencesForm
        {...baseProps()}
        initialRepoConnectionId="con-1"
        initialRepoSlug="acme/repo-b"
        initialEnvironmentId="env-2"
        initialAgentId="agt_1"
      />,
    );
    // The mocked Select wraps its children in a div carrying data-current-value.
    const repoDiv = fieldScope("Default repository").querySelector(
      "[data-current-value]",
    );
    expect(repoDiv).toHaveAttribute("data-current-value", "con-1::acme/repo-b");
    const envDiv = fieldScope("Default environment").querySelector(
      "[data-current-value]",
    );
    expect(envDiv).toHaveAttribute("data-current-value", "env-2");
    const agentDiv = fieldScope("Default agent").querySelector(
      "[data-current-value]",
    );
    expect(agentDiv).toHaveAttribute("data-current-value", "agt_1");
  });

  it("falls back to 'No default' when a saved id no longer exists in the live list", () => {
    render(
      <CodingAgentPreferencesForm
        {...baseProps()}
        initialEnvironmentId="env-stale"
        initialAgentId="agt_stale"
      />,
    );
    const envDiv = fieldScope("Default environment").querySelector(
      "[data-current-value]",
    );
    expect(envDiv).toHaveAttribute("data-current-value", "__unset__");
    const agentDiv = fieldScope("Default agent").querySelector(
      "[data-current-value]",
    );
    expect(agentDiv).toHaveAttribute("data-current-value", "__unset__");
  });

  it("saves the resolved connectionId + owner/repo slug, env id, and agent id", async () => {
    mockAction.mockResolvedValue({ ok: true });
    render(<CodingAgentPreferencesForm {...baseProps()} />);

    await userEvent.click(
      within(fieldScope("Default repository")).getByRole("button", {
        name: "acme/repo-a",
      }),
    );
    await userEvent.click(
      within(fieldScope("Default environment")).getByRole("button", {
        name: /Staging/,
      }),
    );
    await userEvent.click(
      within(fieldScope("Default agent")).getByRole("button", {
        name: "Coder",
      }),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Save preferences" }),
    );

    await waitFor(() => expect(mockAction).toHaveBeenCalledTimes(1));
    expect(mockAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      defaultRepoConnectionId: "con-1",
      defaultRepoSlug: "acme/repo-a",
      defaultEnvironmentId: "env-2",
      defaultAgentId: "agt_1",
    });
    expect(await screen.findByText(/Saved at/)).toBeInTheDocument();
  });

  it("sends nulls when the user clears a previously-saved default", async () => {
    mockAction.mockResolvedValue({ ok: true });
    render(
      <CodingAgentPreferencesForm
        {...baseProps()}
        initialRepoConnectionId="con-1"
        initialRepoSlug="acme/repo-a"
        initialEnvironmentId="env-1"
        initialAgentId="agt_1"
      />,
    );

    await userEvent.click(
      within(fieldScope("Default repository")).getByRole("button", {
        name: "No default",
      }),
    );
    await userEvent.click(
      within(fieldScope("Default environment")).getByRole("button", {
        name: "No default",
      }),
    );
    await userEvent.click(
      within(fieldScope("Default agent")).getByRole("button", {
        name: "No default",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save preferences" }),
    );

    await waitFor(() => expect(mockAction).toHaveBeenCalledTimes(1));
    expect(mockAction).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultRepoConnectionId: null,
        defaultRepoSlug: null,
        defaultEnvironmentId: null,
        defaultAgentId: null,
      }),
    );
  });

  it("shows an inline error and does not throw when the action fails", async () => {
    mockAction.mockResolvedValue({
      ok: false,
      error: "Failed to save coding-agent preferences.",
    });
    render(<CodingAgentPreferencesForm {...baseProps()} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Save preferences" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to save coding-agent preferences.",
    );
  });
});
