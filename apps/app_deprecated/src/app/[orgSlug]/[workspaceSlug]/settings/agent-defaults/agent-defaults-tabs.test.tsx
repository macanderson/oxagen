// @vitest-environment jsdom
/**
 * agent-defaults-tabs.test.tsx — component tests for AgentDefaultsTabs.
 *
 * Covers:
 *   (a) Renders all four sub-tabs ("Models", "Budget", "Prompts",
 *       "Memory Policy") and the initial panel.
 *   (b) initialTab controls which panel renders first.
 *   (c) Clicking a non-default sub-tab updates the URL with `?tab=<value>`.
 *   (d) Clicking back to "Models" (the default) clears the query param.
 */

import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";

const { mockReplace } = vi.hoisted(() => ({ mockReplace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/acme/prod/settings/agent-defaults",
}));

import { AgentDefaultsTabs } from "./agent-defaults-tabs";
import { isAgentDefaultsTab } from "./agent-defaults-tabs-shared";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderTabs(initialTab: "models" | "budget" | "prompts" | "memory") {
  return render(
    <AgentDefaultsTabs
      initialTab={initialTab}
      modelsPanel={<p>Models panel content</p>}
      budgetPanel={<p>Budget panel content</p>}
      promptsPanel={<p>Prompts panel content</p>}
      memoryPanel={<p>Memory panel content</p>}
    />,
  );
}

describe("isAgentDefaultsTab", () => {
  it("accepts the four known tab values", () => {
    expect(isAgentDefaultsTab("models")).toBe(true);
    expect(isAgentDefaultsTab("budget")).toBe(true);
    expect(isAgentDefaultsTab("prompts")).toBe(true);
    expect(isAgentDefaultsTab("memory")).toBe(true);
  });

  it("rejects unknown or missing values", () => {
    expect(isAgentDefaultsTab("bogus")).toBe(false);
    expect(isAgentDefaultsTab(undefined)).toBe(false);
  });
});

describe("AgentDefaultsTabs", () => {
  it("renders all four sub-tabs and the Models panel by default", () => {
    renderTabs("models");
    expect(screen.getByRole("tab", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Budget" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Prompts" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Memory Policy" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Models panel content")).toBeInTheDocument();
  });

  it("renders the Memory Policy panel first when initialTab is 'memory'", () => {
    renderTabs("memory");
    expect(screen.getByText("Memory panel content")).toBeInTheDocument();
  });

  it("switches to Budget and updates the URL with ?tab=budget", async () => {
    renderTabs("models");
    await userEvent.click(screen.getByRole("tab", { name: "Budget" }));
    expect(screen.getByText("Budget panel content")).toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith(
      "/acme/prod/settings/agent-defaults?tab=budget",
      { scroll: false },
    );
  });

  it("switches to Prompts and updates the URL with ?tab=prompts", async () => {
    renderTabs("models");
    await userEvent.click(screen.getByRole("tab", { name: "Prompts" }));
    expect(screen.getByText("Prompts panel content")).toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith(
      "/acme/prod/settings/agent-defaults?tab=prompts",
      { scroll: false },
    );
  });

  it("switching back to Models clears the query param", async () => {
    renderTabs("budget");
    await userEvent.click(screen.getByRole("tab", { name: "Models" }));
    expect(screen.getByText("Models panel content")).toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith(
      "/acme/prod/settings/agent-defaults",
      {
        scroll: false,
      },
    );
  });
});
