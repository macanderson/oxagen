// @vitest-environment jsdom
/**
 * chat-agent-toolbar.test.tsx
 *
 * Unit tests for ChatAgentToolbar:
 *   - Renders the repo + environment selectors
 *   - Shows the "owner/name • env" summary once both are selected
 *   - Collapses the picker row when isCollapsed is true
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("./repo-selector", () => ({
  RepoSelector: ({ repositories }: { repositories: Array<{ key: string; owner: string; name: string }> }) => (
    <div data-testid="repo-selector">{repositories.length} repos</div>
  ),
}));

vi.mock("./environment-selector", () => ({
  EnvironmentSelector: ({ environments }: { environments: Array<{ id: string; name: string }> }) => (
    <div data-testid="environment-selector">{environments.length} environments</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, title }: { children: React.ReactNode; onClick?: () => void; title?: string }) => (
    <button type="button" onClick={onClick} title={title}>
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return { ...real, ChevronDown: () => <span data-testid="icon-chevron" /> };
});

describe("ChatAgentToolbar", () => {
  it("renders the repo and environment selectors", async () => {
    const { ChatAgentToolbar } = await import("./chat-agent-toolbar");
    render(
      <ChatAgentToolbar
        repositories={[]}
        environments={[]}
        selectedRepoKey={null}
        selectedEnvId={null}
        onSelectRepo={vi.fn()}
        onSelectEnv={vi.fn()}
      />,
    );
    expect(screen.getByTestId("repo-selector")).toBeInTheDocument();
    expect(screen.getByTestId("environment-selector")).toBeInTheDocument();
  });

  it("shows the owner/name + environment summary once both are selected", async () => {
    const { ChatAgentToolbar } = await import("./chat-agent-toolbar");
    render(
      <ChatAgentToolbar
        repositories={[{ key: "con_1::acme/widgets", connectionId: "con_1", owner: "acme", name: "widgets", defaultBranch: "main" }]}
        environments={[{ id: "env_default", name: "Default", isDefault: true }]}
        selectedRepoKey="con_1::acme/widgets"
        selectedEnvId="env_default"
        onSelectRepo={vi.fn()}
        onSelectEnv={vi.fn()}
      />,
    );
    expect(screen.getByText("acme/widgets")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("hides the picker row when isCollapsed is true", async () => {
    const { ChatAgentToolbar } = await import("./chat-agent-toolbar");
    const { container } = render(
      <ChatAgentToolbar
        repositories={[]}
        environments={[]}
        selectedRepoKey={null}
        selectedEnvId={null}
        onSelectRepo={vi.fn()}
        onSelectEnv={vi.fn()}
        isCollapsed
      />,
    );
    const pickerRow = container.querySelector(".hidden");
    expect(pickerRow).not.toBeNull();
  });
});
