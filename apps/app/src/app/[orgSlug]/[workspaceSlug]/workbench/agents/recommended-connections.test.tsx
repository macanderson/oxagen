// @vitest-environment jsdom
/**
 * recommended-connections.test.tsx — render tests for the "connect this next"
 * panel.
 *
 * The suggest action is a Next server action (not a mockable /api SSE route), so
 * the AI-generated recommendations can't be stubbed through the e2e page flow —
 * see the note in e2e/workbench-agent-ai-setup.spec.ts. This component test covers
 * the panel directly instead: each recommendation renders its name + reason +
 * kind badge, and the Connect affordance links to the right surface (MCP server
 * → developer MCP page, skill → Workbench skills page) in a new tab.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { RecommendedConnections } from "./recommended-connections";
import type { AgentRecommendation } from "./suggestion-mapping";

afterEach(cleanup);

const MCP_REC: AgentRecommendation = {
  kind: "mcp_server",
  ref: "github/github-mcp-server",
  name: "GitHub",
  reason: "Watches merged PRs — needs GitHub access.",
};
const SKILL_REC: AgentRecommendation = {
  kind: "skill",
  ref: "changelog-formatter",
  name: "Changelog Formatter",
  reason: "Formats the drafted notes; currently disabled.",
};

function renderPanel(recommendations: AgentRecommendation[]) {
  return render(
    <RecommendedConnections
      recommendations={recommendations}
      orgSlug="acme"
      workspaceSlug="eng"
    />,
  );
}

describe("RecommendedConnections", () => {
  it("renders nothing when there are no recommendations", () => {
    const { container } = renderPanel([]);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("agent-recommendations")).toBeNull();
  });

  it("renders the panel heading and every recommendation's name + reason", () => {
    renderPanel([MCP_REC, SKILL_REC]);
    expect(screen.getByTestId("agent-recommendations")).toBeInTheDocument();
    expect(screen.getByText("Recommended connections")).toBeInTheDocument();

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(
      screen.getByText("Watches merged PRs — needs GitHub access."),
    ).toBeInTheDocument();
    expect(screen.getByText("Changelog Formatter")).toBeInTheDocument();
    expect(
      screen.getByText("Formats the drafted notes; currently disabled."),
    ).toBeInTheDocument();
  });

  it("labels each recommendation with its kind badge", () => {
    renderPanel([MCP_REC, SKILL_REC]);
    const mcpRow = screen.getByTestId(
      "agent-recommendation-github/github-mcp-server",
    );
    expect(within(mcpRow).getByText("MCP server")).toBeInTheDocument();
    const skillRow = screen.getByTestId(
      "agent-recommendation-changelog-formatter",
    );
    expect(within(skillRow).getByText("Skill")).toBeInTheDocument();
  });

  it("links an MCP-server recommendation to the developer MCP page in a new tab", () => {
    renderPanel([MCP_REC]);
    const connect = screen.getByTestId(
      "agent-recommendation-connect-github/github-mcp-server",
    );
    expect(connect.getAttribute("href")).toContain("/developer/mcp");
    expect(connect.getAttribute("target")).toBe("_blank");
    expect(connect.getAttribute("rel")).toContain("noreferrer");
  });

  it("links a skill recommendation to the Workbench skills page in a new tab", () => {
    renderPanel([SKILL_REC]);
    const connect = screen.getByTestId(
      "agent-recommendation-connect-changelog-formatter",
    );
    expect(connect.getAttribute("href")).toContain("/workbench/tools/skills");
    expect(connect.getAttribute("target")).toBe("_blank");
  });
});
