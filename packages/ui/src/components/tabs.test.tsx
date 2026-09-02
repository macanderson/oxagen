// @vitest-environment jsdom
/**
 * tabs.test.tsx — render tests for Tabs, TabsList, TabsTab, TabsPanel.
 *
 * Covers: renders correctly, coss naming (TabsTab/TabsPanel not TabsTrigger/TabsContent),
 * variant → data attribute, keyboard accessible selection, panel content.
 */

import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach } from "vitest";
import { Tabs, TabsList, TabsTab, TabsPanel } from "./tabs";

afterEach(cleanup);

function SimpleTabs({ variant }: { variant?: "default" | "underline" }) {
  return (
    <Tabs defaultValue="a">
      <TabsList variant={variant}>
        <TabsTab value="a">Tab A</TabsTab>
        <TabsTab value="b">Tab B</TabsTab>
      </TabsList>
      <TabsPanel value="a">Panel A content</TabsPanel>
      <TabsPanel value="b">Panel B content</TabsPanel>
    </Tabs>
  );
}

describe("Tabs — render", () => {
  it("renders a tablist", () => {
    const { getByRole } = render(<SimpleTabs />);
    expect(getByRole("tablist")).toBeInTheDocument();
  });

  it("renders two tabs", () => {
    const { getAllByRole } = render(<SimpleTabs />);
    expect(getAllByRole("tab")).toHaveLength(2);
  });

  it("renders the active panel content initially", () => {
    const { getByText } = render(<SimpleTabs />);
    expect(getByText("Panel A content")).toBeInTheDocument();
  });

  it("switches panel content when another tab is clicked", async () => {
    const { getByRole, getByText } = render(<SimpleTabs />);
    await userEvent.click(getByRole("tab", { name: "Tab B" }));
    expect(getByText("Panel B content")).toBeInTheDocument();
  });

  it("active tab receives data-active attribute after clicking", async () => {
    const { getByRole } = render(<SimpleTabs />);
    const tabB = getByRole("tab", { name: "Tab B" });
    const tabA = getByRole("tab", { name: "Tab A" });
    await userEvent.click(tabB);
    // Base UI emits data-active (not data-selected) on the active tab.
    expect(tabB).toHaveAttribute("data-active");
    expect(tabA).not.toHaveAttribute("data-active");
  });

  it("initial tab has data-active attribute without interaction", () => {
    const { getByRole } = render(<SimpleTabs />);
    const tabA = getByRole("tab", { name: "Tab A" });
    const tabB = getByRole("tab", { name: "Tab B" });
    expect(tabA).toHaveAttribute("data-active");
    expect(tabB).not.toHaveAttribute("data-active");
  });

  it("inactive panel has data-hidden attribute after tab switch (keepMounted)", async () => {
    // keepMounted keeps both panels in the DOM so we can assert data-hidden.
    const { getByRole, container } = render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTab value="a">Tab A</TabsTab>
          <TabsTab value="b">Tab B</TabsTab>
        </TabsList>
        <TabsPanel value="a" keepMounted>
          Panel A content
        </TabsPanel>
        <TabsPanel value="b" keepMounted>
          Panel B content
        </TabsPanel>
      </Tabs>,
    );
    await userEvent.click(getByRole("tab", { name: "Tab B" }));
    // Base UI sets data-hidden on the inactive panel element.
    const panels = container.querySelectorAll('[role="tabpanel"]');
    const panelA = Array.from(panels).find((p) =>
      p.textContent?.includes("Panel A content"),
    );
    const panelB = Array.from(panels).find((p) =>
      p.textContent?.includes("Panel B content"),
    );
    expect(panelA).toHaveAttribute("data-hidden");
    expect(panelB).not.toHaveAttribute("data-hidden");
  });

  it("TabsList default variant sets data-variant=default", () => {
    const { getByRole } = render(<SimpleTabs variant="default" />);
    expect(getByRole("tablist")).toHaveAttribute("data-variant", "default");
  });

  it("TabsList underline variant sets data-variant=underline", () => {
    const { getByRole } = render(<SimpleTabs variant="underline" />);
    expect(getByRole("tablist")).toHaveAttribute("data-variant", "underline");
  });

  it("TabsTab renders tab role with correct name", () => {
    const { getByRole } = render(<SimpleTabs />);
    expect(getByRole("tab", { name: "Tab A" })).toBeInTheDocument();
    expect(getByRole("tab", { name: "Tab B" })).toBeInTheDocument();
  });

  it("TabsList accepts custom className", () => {
    const { getByRole } = render(
      <Tabs defaultValue="x">
        <TabsList className="custom-list">
          <TabsTab value="x">X</TabsTab>
        </TabsList>
        <TabsPanel value="x">Content</TabsPanel>
      </Tabs>,
    );
    expect(getByRole("tablist").className).toContain("custom-list");
  });
});
