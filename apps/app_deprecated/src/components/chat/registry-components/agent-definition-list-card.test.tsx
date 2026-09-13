// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import AgentDefinitionListCard from "./agent-definition-list-card";

afterEach(cleanup);

function agent(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "a1",
    publicId: "agt_1",
    slug: "ds-drift-auditor",
    agentKey: "org.ws.ds-drift-auditor",
    name: "Design System Drift Auditor",
    description: "Audits frontend code.",
    agentType: "custom",
    status: "active",
    deploymentStatus: "active",
    latestVersion: 3,
    managed: false,
    ...overrides,
  };
}

describe("AgentDefinitionListCard", () => {
  it("renders the 'Agents' heading with a count, not the raw capability name", () => {
    render(
      <AgentDefinitionListCard
        capability="agent.definition.list"
        output={{
          agents: [
            agent(),
            agent({ publicId: "agt_2", name: "Feature Inference Agent" }),
          ],
        }}
        orgSlug="acme"
        workspaceSlug="ws"
      />,
    );
    expect(screen.getByText("Agents")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    // Never surface the humanized capability label as the card title.
    expect(screen.queryByText("Agent definition list")).toBeNull();
  });

  it("shows name on top, slug muted beneath, version, and deep-links to Workbench", () => {
    render(
      <AgentDefinitionListCard
        output={{ agents: [agent()] }}
        orgSlug="acme"
        workspaceSlug="ws"
      />,
    );
    expect(screen.getByText("Design System Drift Auditor")).toBeTruthy();
    expect(screen.getByText("ds-drift-auditor")).toBeTruthy();
    expect(screen.getByText("v3")).toBeTruthy();
    const link = screen.getByText("Design System Drift Auditor").closest("a");
    expect(link?.getAttribute("href")).toBe("/acme/ws/workbench/agents/agt_1");
  });

  it("uses a blue (info) dot + 'Active' label for a deployed agent", () => {
    render(<AgentDefinitionListCard output={{ agents: [agent()] }} />);
    const dot = document.querySelector("span.bg-info");
    expect(dot).toBeTruthy();
    expect(dot?.getAttribute("title")).toBe("Active");
  });

  it("uses a grey (muted) dot for an undeployed/draft agent", () => {
    render(
      <AgentDefinitionListCard
        output={{
          agents: [agent({ status: "draft", deploymentStatus: "inactive" })],
        }}
      />,
    );
    const dot = document.querySelector("span.bg-muted-foreground");
    expect(dot).toBeTruthy();
    expect(dot?.getAttribute("title")).toBe("Draft");
    // never green/success for a non-running definition-list row
    expect(document.querySelector("span.bg-success")).toBeNull();
  });

  it("shows a Managed tag only for product-managed agents", () => {
    render(
      <AgentDefinitionListCard
        output={{
          agents: [
            agent({ managed: true }),
            agent({ publicId: "agt_2", managed: false }),
          ],
        }}
      />,
    );
    expect(screen.getAllByText("Managed")).toHaveLength(1);
  });

  it("falls back gracefully for a null version and missing name", () => {
    render(
      <AgentDefinitionListCard
        output={{ agents: [agent({ latestVersion: null, name: "" })] }}
      />,
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("Untitled agent")).toBeTruthy();
  });

  it("renders rows without a link when tenant slugs are absent", () => {
    render(<AgentDefinitionListCard output={{ agents: [agent()] }} />);
    const link = screen.getByText("Design System Drift Auditor").closest("a");
    expect(link).toBeNull();
  });

  it("renders an empty state", () => {
    render(<AgentDefinitionListCard output={{ agents: [] }} />);
    expect(screen.getByText("No agents in this workspace.")).toBeTruthy();
  });

  it("tolerates a malformed output shape", () => {
    render(<AgentDefinitionListCard output={{ agents: "nope" }} />);
    expect(screen.getByText("No agents in this workspace.")).toBeTruthy();
  });
});
