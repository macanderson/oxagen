// @vitest-environment jsdom
/**
 * agents-list.test.tsx — component tests for AgentsList.
 *
 * Covers: empty state, populated table, status/deployment/version/trigger
 * columns, detail links, and the create affordance gated by canEdit.
 */
import * as React from "react";
import { render, screen, cleanup, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    render: renderEl,
  }: {
    children: React.ReactNode;
    render?: React.ReactElement<{ children?: React.ReactNode }>;
  }) =>
    renderEl ? React.cloneElement(renderEl, undefined, children) : <button>{children}</button>,
}));

vi.mock("lucide-react", () => ({
  Bot: () => <svg aria-hidden="true" />,
  Plus: () => <svg aria-hidden="true" />,
  ShieldCheck: () => <svg aria-hidden="true" data-testid="shield-check-icon" />,
}));

import { AgentsList, type AgentRow } from "./agents-list";

const baseProps = { canEdit: true, orgSlug: "acme", workspaceSlug: "prod" };

const agents: AgentRow[] = [
  {
    agentId: "agt_1",
    publicId: "agt_1",
    slug: "repo-review",
    name: "Repo Review",
    description: "Reviews repo changes",
    status: "active",
    deploymentStatus: "active",
    latestVersion: 3,
    triggerCount: 2,
    managed: false,
  },
  {
    agentId: "agt_2",
    publicId: "agt_2",
    slug: "draft-bot",
    name: "Draft Bot",
    description: null,
    status: "draft",
    deploymentStatus: "inactive",
    latestVersion: 1,
    triggerCount: 0,
    managed: false,
  },
];

describe("AgentsList", () => {
  afterEach(() => cleanup());

  it("renders an empty state when there are no agents", () => {
    render(<AgentsList {...baseProps} agents={[]} />);
    expect(screen.getByText(/no agents yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create agent/i })).toHaveAttribute(
      "href",
      "/acme/prod/automation/agents/new",
    );
  });

  it("hides create affordances when canEdit is false", () => {
    render(<AgentsList {...baseProps} canEdit={false} agents={[]} />);
    expect(screen.queryByRole("link", { name: /create agent/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new agent/i })).not.toBeInTheDocument();
  });

  it("renders a row per agent with name link to detail", () => {
    render(<AgentsList {...baseProps} agents={agents} />);
    const repoLink = screen.getByRole("link", { name: /repo review/i });
    expect(repoLink).toHaveAttribute("href", "/acme/prod/automation/agents/repo-review");
    const draftLink = screen.getByRole("link", { name: /draft bot/i });
    expect(draftLink).toHaveAttribute("href", "/acme/prod/automation/agents/draft-bot");
  });

  it("shows version and trigger count per row", () => {
    render(<AgentsList {...baseProps} agents={agents} />);
    const rows = screen.getAllByRole("row");
    // rows[0] is the header; data rows follow.
    const repoRow = rows.find((r) => within(r).queryByText(/repo review/i));
    expect(repoRow).toBeDefined();
    expect(within(repoRow as HTMLElement).getByText("v3")).toBeInTheDocument();
    expect(within(repoRow as HTMLElement).getByText("Active")).toBeInTheDocument();
    expect(within(repoRow as HTMLElement).getByText("Deployed")).toBeInTheDocument();
  });

  it("shows the New agent button when canEdit and agents exist", () => {
    render(<AgentsList {...baseProps} agents={agents} />);
    expect(screen.getByRole("link", { name: /new agent/i })).toHaveAttribute(
      "href",
      "/acme/prod/automation/agents/new",
    );
  });

  it("shows the Managed badge on a managed agent row", () => {
    const managed: AgentRow = {
      agentId: "agt_managed",
      publicId: "agt_managed",
      slug: "qa-chat",
      name: "QA Chat",
      description: "Product-managed QA agent",
      status: "active",
      deploymentStatus: "active",
      latestVersion: 1,
      triggerCount: 0,
      managed: true,
    };
    render(<AgentsList {...baseProps} agents={[managed]} />);
    expect(screen.getByText("Managed")).toBeInTheDocument();
  });

  it("does not show the Managed badge on a non-managed agent row", () => {
    render(<AgentsList {...baseProps} agents={agents} />);
    expect(screen.queryByText("Managed")).not.toBeInTheDocument();
  });
});
