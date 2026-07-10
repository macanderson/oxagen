// @vitest-environment jsdom
/**
 * agents-grid.test.tsx — card-grid behavior: cards render with avatar +
 * summary blurb, search filters, pagination appears past one page, CSV
 * export serializes the filtered rows, and the e2e-relied testids/link
 * order hold (`agent-row-<slug>` with the detail link first).
 *
 * `@/components/ui/select` is mocked to a plain stand-in (established repo
 * pattern — the Base UI Select portals and is tested in packages/ui).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentsGrid, type AgentGridRow } from "./agents-grid";

afterEach(cleanup);

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  SelectValue: () => <span />,
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const downloadCsv = vi.hoisted(() => vi.fn());
vi.mock("@/lib/lists/csv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lists/csv")>();
  return { ...actual, downloadCsv };
});

function agent(
  overrides: Partial<AgentGridRow> & { slug: string },
): AgentGridRow {
  return {
    agentId: `id-${overrides.slug}`,
    publicId: `agt_${overrides.slug}`,
    agentKey: `org.ws.${overrides.slug}`,
    name: overrides.slug,
    description: null,
    status: "draft",
    deploymentStatus: "inactive",
    latestVersion: 1,
    managed: false,
    avatarUrl: null,
    summary: null,
    detailHref: `/acme/default/workbench/agents/agt_${overrides.slug}`,
    launchHref: null,
    ...overrides,
  };
}

describe("AgentsGrid", () => {
  it("renders a card per agent with the summary blurb and keeps the detail link first", () => {
    render(
      <AgentsGrid
        agents={[
          agent({
            slug: "billing-bot",
            name: "Billing Bot",
            summary: "Answers billing questions from Stripe data.",
            status: "active",
            deploymentStatus: "active",
            launchHref: "/acme/default/ask?agent=agt_billing-bot",
          }),
          agent({
            slug: "qa-chat",
            name: "QA Chat",
            description: "Manual QA helper.",
          }),
        ]}
      />,
    );

    const billing = screen.getByTestId("agent-row-billing-bot");
    expect(
      within(billing).getByText("Answers billing questions from Stripe data."),
    ).toBeDefined();
    // e2e contract: the FIRST link in the card navigates to the agent detail.
    const links = within(billing).getAllByRole("link");
    expect(links[0]?.getAttribute("href")).toBe(
      "/acme/default/workbench/agents/agt_billing-bot",
    );
    expect(
      within(billing).getByTestId("agent-launch-billing-bot"),
    ).toBeDefined();

    // Description falls back when no summary exists yet.
    const qa = screen.getByTestId("agent-row-qa-chat");
    expect(within(qa).getByText("Manual QA helper.")).toBeDefined();
    expect(within(qa).getByTestId("agent-edit-qa-chat")).toBeDefined();
  });

  it("never duplicates 'Active' — deployment renders as Deployed/Not deployed", () => {
    render(
      <AgentsGrid
        agents={[
          agent({
            slug: "billing-bot",
            name: "Billing Bot",
            status: "active",
            deploymentStatus: "active",
          }),
          agent({ slug: "qa-chat", name: "QA Chat" }), // draft + inactive
        ]}
      />,
    );

    // Regression: status="active" + deploymentStatus="active" used to render
    // two identical "Active" badges side by side.
    const billing = screen.getByTestId("agent-row-billing-bot");
    expect(within(billing).getAllByText(/^active$/i)).toHaveLength(1);
    expect(within(billing).getByText("Deployed")).toBeDefined();

    const qa = screen.getByTestId("agent-row-qa-chat");
    expect(within(qa).getByText(/^draft$/i)).toBeDefined();
    expect(within(qa).getByText("Not deployed")).toBeDefined();
  });

  it("filters cards by search query across name/slug/summary", async () => {
    const user = userEvent.setup();
    render(
      <AgentsGrid
        agents={[
          agent({ slug: "billing-bot", name: "Billing Bot" }),
          agent({ slug: "qa-chat", name: "QA Chat" }),
        ]}
      />,
    );

    await user.type(screen.getByRole("searchbox"), "billing");
    expect(screen.getByTestId("agent-row-billing-bot")).toBeDefined();
    expect(screen.queryByTestId("agent-row-qa-chat")).toBeNull();

    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "no-such-agent");
    expect(screen.getByTestId("agents-no-matches")).toBeDefined();
  });

  it("paginates past 12 agents", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      agent({ slug: `agent-${String(i).padStart(2, "0")}` }),
    );
    render(<AgentsGrid agents={many} />);

    // Page 1 shows 12 cards; pagination reports 2 pages.
    expect(screen.getAllByTestId(/^agent-row-/)).toHaveLength(12);
    expect(screen.getByText(/page 1 of 2/i)).toBeDefined();
  });

  it("exports the filtered rows as CSV", async () => {
    const user = userEvent.setup();
    render(
      <AgentsGrid
        agents={[
          agent({
            slug: "billing-bot",
            name: "Billing Bot",
            summary: "Bills.",
          }),
          agent({ slug: "qa-chat", name: "QA Chat" }),
        ]}
      />,
    );

    await user.type(screen.getByRole("searchbox"), "billing");
    await user.click(screen.getByRole("button", { name: /export/i }));

    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [filename, csv] = downloadCsv.mock.calls[0] as [string, string];
    expect(filename).toBe("agents.csv");
    expect(csv).toContain("Billing Bot");
    expect(csv).not.toContain("QA Chat");
  });
});
