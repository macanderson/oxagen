// @vitest-environment jsdom
/**
 * agent-detail.test.tsx — component tests for AgentDetail.
 *
 * Covers: header + definition render, publish (shows returned checksum),
 * deploy toggle (activate), the typed activation error surfaced verbatim, and
 * the canEdit gate on lifecycle controls.
 */
import * as React from "react";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPublish, mockDeploy, mockRefresh, mockAddToast } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
  mockDeploy: vi.fn(),
  mockRefresh: vi.fn(),
  mockAddToast: vi.fn(),
}));

vi.mock("../agent-actions", () => ({
  publishAgentAction: mockPublish,
  deployAgentAction: mockDeploy,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    disabled,
    render: renderEl,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    render?: React.ReactElement<{ children?: React.ReactNode }>;
  }) =>
    renderEl ? (
      React.cloneElement(renderEl, undefined, children)
    ) : (
      <button type={type ?? "button"} onClick={onClick} disabled={disabled}>
        {children}
      </button>
    ),
}));

vi.mock("lucide-react", () => ({
  Pencil: () => <svg aria-hidden="true" />,
  Rocket: () => <svg aria-hidden="true" />,
  UploadCloud: () => <svg aria-hidden="true" />,
}));

// Isolate the detail view from the trigger panel internals.
vi.mock("./triggers-panel", () => ({
  TriggersPanel: () => <div data-testid="triggers-panel" />,
}));

import { AgentDetail } from "./agent-detail";
import type { AgentDefinitionGetOutput } from "../agent-actions";

const agent: AgentDefinitionGetOutput = {
  agentId: "agt_1",
  publicId: "agt_1",
  slug: "repo-review",
  name: "Repo Review",
  description: "Reviews repo changes",
  agentType: "custom",
  status: "draft",
  deploymentStatus: "inactive",
  version: 1,
  isPublished: false,
  config: {
    graph: {
      ontologyId: "wrk_1",
      mode: "read",
      retrieval: { strategy: "hybrid" },
      budget: { maxHops: 3, maxNodes: 50, minRelevance: 0.5 },
    },
    agentTools: [{ type: "skill", ref: "coding" }],
    triggers: [],
    instructions: "Do the thing",
  },
};

const baseProps = {
  agent,
  triggers: [],
  canEdit: true,
  orgSlug: "acme",
  workspaceSlug: "prod",
  agentSlug: "repo-review",
};

describe("AgentDetail", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("renders the header, definition, and tools", () => {
    render(<AgentDetail {...baseProps} />);
    expect(screen.getByRole("heading", { name: /repo review/i })).toBeInTheDocument();
    expect(screen.getByText(/skill: coding/i)).toBeInTheDocument();
    expect(screen.getByText("Do the thing")).toBeInTheDocument();
    expect(screen.getByTestId("triggers-panel")).toBeInTheDocument();
  });

  it("links to the edit page", () => {
    render(<AgentDetail {...baseProps} />);
    expect(screen.getByRole("link", { name: /edit/i })).toHaveAttribute(
      "href",
      "/acme/prod/agents/repo-review/edit",
    );
  });

  it("publishes and shows the returned checksum", async () => {
    mockPublish.mockResolvedValue({
      ok: true,
      data: { agentId: "agt_1", version: 1, checksum: "abc123", activeVersionId: "ver_1" },
    });
    render(<AgentDetail {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /publish latest version/i }));
    await waitFor(() => expect(mockPublish).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText(/abc123/)).toBeInTheDocument());
  });

  it("activates deployment via deployAgentAction", async () => {
    mockDeploy.mockResolvedValue({ ok: true, data: { agentId: "agt_1", deploymentStatus: "active" } });
    render(<AgentDetail {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /deploy \(activate\)/i }));
    await waitFor(() => expect(mockDeploy).toHaveBeenCalledOnce());
    expect((mockDeploy.mock.calls[0]![0] as { deploymentStatus: string }).deploymentStatus).toBe(
      "active",
    );
  });

  it("surfaces the typed activation error verbatim", async () => {
    mockDeploy.mockResolvedValue({
      ok: false,
      error:
        'Agent "agt_1" cannot be activated: it has no published active version. Publish a version first.',
      code: "agent_deploy_requires_published_version",
    });
    render(<AgentDetail {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /deploy \(activate\)/i }));
    await waitFor(() =>
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Cannot change deployment",
          description: expect.stringContaining("no published active version"),
        }),
      ),
    );
  });

  it("hides lifecycle controls when canEdit is false", () => {
    render(<AgentDetail {...baseProps} canEdit={false} />);
    expect(
      screen.queryByRole("button", { name: /publish latest version/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /edit/i })).not.toBeInTheDocument();
  });
});
