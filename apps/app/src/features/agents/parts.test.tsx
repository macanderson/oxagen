// @vitest-environment jsdom
// The pieces every Agents section is drawn from (parts.tsx): a panel's state
// edge, a tile whose figure is a problem when it is not zero, a not-recorded
// value that names the store it waits on, and a pager that draws nothing
// when there is no other page. Axe runs after every test (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { NotRecordedValue, Pager, Panel, Tile } = await import("./parts");

function draw(node: ReactNode) {
  render(<IntlProvider>{node}</IntlProvider>);
}

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("Panel", () => {
  it.each([
    ["proven", "border-proven/35"],
    ["critical", "border-critical/35"],
    ["approval", "border-info/35"],
  ] as const)("edges a %s panel in its hue", (tone, edge) => {
    draw(
      <Panel id="p" title="Panel" tone={tone}>
        body
      </Panel>,
    );
    expect(screen.getByRole("region", { name: "Panel" })).toHaveClass(edge);
  });

  it("draws no lead, aside or edge when none is given (negative)", () => {
    draw(
      <Panel id="p" title="Panel">
        body
      </Panel>,
    );
    const panel = screen.getByRole("region", { name: "Panel" });
    expect(panel.className).not.toMatch(/border-(proven|critical|info)\//);
    expect(panel.querySelector("p")).toBeNull();
  });
});

describe("Tile", () => {
  it("marks a critical figure in the critical hue", () => {
    draw(<Tile title="Tamper" value="3" basis="open" critical />);
    const value = within(screen.getByTestId("tile")).getByText("3");
    expect(value).toHaveAttribute("data-critical", "true");
    expect(value).toHaveClass("text-critical");
  });

  it("carries no critical mark by default (negative)", () => {
    draw(<Tile title="Runs" value="4" basis="30 days" />);
    const value = within(screen.getByTestId("tile")).getByText("4");
    expect(value).not.toHaveAttribute("data-critical");
    expect(value).not.toHaveClass("text-critical");
  });
});

describe("NotRecordedValue", () => {
  it("names the store it waits on when given a gap", () => {
    draw(<NotRecordedValue gap="tier" />);
    const value = screen.getByText("not recorded");
    expect(value).toHaveAttribute("data-gap", "tier");
    expect(value).toHaveAttribute(
      "title",
      "No wrapped session has recorded an enforcement tier for this agent yet.",
    );
  });

  it("carries no gap and no title without one (negative)", () => {
    draw(<NotRecordedValue />);
    const value = screen.getByText("not recorded");
    expect(value).not.toHaveAttribute("data-gap");
    expect(value).not.toHaveAttribute("title");
  });
});

describe("Pager", () => {
  const to = routes.agent("acme", "core-platform", "release-bot", {
    tab: "activity",
  });

  it("draws nothing when there is neither a first nor a next page (negative)", () => {
    draw(<Pager label="Pages" first={null} next={null} />);
    expect(screen.queryByRole("navigation", { name: "Pages" })).toBeNull();
  });

  it("draws only the link it is given", () => {
    draw(<Pager label="Pages" first={{ to, text: "Newest" }} next={null} />);
    const nav = screen.getByRole("navigation", { name: "Pages" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Newest"]);
  });
});
