// @vitest-environment jsdom
/**
 * recommended-connections.test.tsx — render tests for the "connect this next"
 * panel.
 *
 * The suggest action is a Next server action (not a mockable /api SSE route), so
 * the AI-generated recommendations can't be stubbed through the e2e page flow —
 * see the note in e2e/workbench-agent-ai-setup.spec.ts. This component test covers
 * the panel directly instead: each connectable recommendation renders its name +
 * reason + kind badge, the Connect affordance links to the developer MCP page in
 * a new tab, and (ADR-043) a `skill` recommendation is filtered out entirely
 * because skills no longer have a surface to connect on.
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
const SKILL_REC = {
  kind: "skill",
  ref: "changelog-formatter",
  name: "Changelog Formatter",
  reason: "Formats the drafted notes; currently disabled.",
} as unknown as AgentRecommendation;

function renderPanel(recommendations: AgentRecommendation[]) {
  return render(
    <RecommendedConnections recommendations={recommendations} orgSlug="acme" />,
  );
}

describe("RecommendedConnections", () => {
  it("renders nothing when there are no recommendations", () => {
    const { container } = renderPanel([]);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("agent-recommendations")).toBeNull();
  });

  it("renders the panel heading and every recommendation's name + reason", () => {
    renderPanel([MCP_REC]);
    expect(screen.getByTestId("agent-recommendations")).toBeInTheDocument();
    expect(screen.getByText("Recommended connections")).toBeInTheDocument();

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(
      screen.getByText("Watches merged PRs — needs GitHub access."),
    ).toBeInTheDocument();
  });

  it("labels each recommendation with its kind badge", () => {
    renderPanel([MCP_REC]);
    const mcpRow = screen.getByTestId(
      "agent-recommendation-github/github-mcp-server",
    );
    expect(within(mcpRow).getByText("MCP server")).toBeInTheDocument();
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

  it("filters out a skill recommendation — skills are retired (ADR-043)", () => {
    const { container } = renderPanel([SKILL_REC]);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders only the connectable rows when kinds are mixed", () => {
    renderPanel([MCP_REC, SKILL_REC]);
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.queryByText("Changelog Formatter")).toBeNull();
  });
});
