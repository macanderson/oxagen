// @vitest-environment jsdom
// The Waiting on a human tile on its own (#3839): the branches the Fleet
// page tests do not reach, each checked with axe.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  approvalItem,
  approvalQueue,
  interjectionItem,
  interjectionQueue,
  NO_INTERJECTIONS,
  NOW,
} from "./fleet.builders";
import { WaitingTile } from "./waiting-tile";

const DENIED = {
  ok: false as const,
  reason: "denied" as const,
  permission: "workspace.read",
};

function show(props: Parameters<typeof WaitingTile>[0]) {
  render(
    <IntlProvider>
      <WaitingTile {...props} />
    </IntlProvider>,
  );
  return screen.getByRole("button", { name: "Open approvals" });
}

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("WaitingTile", () => {
  // #4370 review: the aria-label replaced the button's name, so a screen
  // reader heard "Open approvals" and never the figure or its note.
  it("describes the figure and its note to a screen reader", () => {
    const tile = show({
      approvals: approvalQueue([approvalItem()]),
      interjections: interjectionQueue([interjectionItem()]),
      now: NOW,
    });
    expect(tile).toHaveAccessibleDescription(/Waiting on a human/);
    expect(tile).toHaveAccessibleDescription(/2/);
  });

  it("names the oldest of several interjections when no approval waits", () => {
    const tile = show({
      approvals: approvalQueue([]),
      interjections: interjectionQueue([
        interjectionItem(),
        interjectionItem({
          id: "inj_newer",
          raisedAt: new Date(NOW - 30_000).toISOString(),
        }),
      ]),
      now: NOW,
    });
    expect(tile).toHaveTextContent(
      "2the oldest of 2 interjections has waited 3:36 of 30m · open the drawer",
    );
  });

  it("counts several interjections beside an approval", () => {
    const tile = show({
      approvals: approvalQueue([approvalItem()]),
      interjections: interjectionQueue([
        interjectionItem(),
        interjectionItem({ id: "inj_2" }),
      ]),
      now: NOW,
    });
    expect(screen.getByTestId("waiting-interjections")).toHaveTextContent(
      "2 interjections",
    );
    expect(tile).toHaveTextContent("3");
  });

  it("marks the figure a floor when the questions ran past the read", () => {
    const tile = show({
      approvals: approvalQueue([]),
      interjections: interjectionQueue([interjectionItem()], true),
      now: NOW,
    });
    expect(tile).toHaveTextContent("1+");
    expect(tile).toHaveTextContent("more questions wait than this page read");
  });

  it("draws no figure when the approvals were not read, and still counts the questions it read (negative)", () => {
    const tile = show({
      approvals: DENIED,
      interjections: interjectionQueue([interjectionItem()]),
      now: NOW,
    });
    expect(tile).toHaveTextContent(
      "Waiting on a human—approvals not read: workspace.read · 1 interjection",
    );
    expect(tile).not.toHaveTextContent("open the drawer");
  });

  // With no approval parked and the questions unread, the tile cannot say
  // nothing is waiting: it drew "0+ nothing is waiting" before this fix.
  it("does not say nothing is waiting when the questions were not read (negative)", () => {
    const tile = show({
      approvals: approvalQueue([]),
      interjections: DENIED,
      now: NOW,
    });
    expect(tile).toHaveTextContent(
      "Waiting on a human0+interjections not read: workspace.read · open the drawer",
    );
    expect(tile).not.toHaveTextContent("nothing is waiting");
  });

  it("says nothing is waiting with no approval and no question", () => {
    const tile = show({
      approvals: approvalQueue([]),
      interjections: NO_INTERJECTIONS,
      now: NOW,
    });
    expect(tile).toHaveTextContent("0nothing is waiting · open the drawer");
  });
});
