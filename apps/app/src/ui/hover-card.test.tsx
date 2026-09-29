// @vitest-environment jsdom
// The hover card (hover-card.tsx): a pointer resting on its trigger opens it,
// the keyboard reaching the trigger opens it too, and the open card shows its
// content and passes axe. The file exports no trigger, because the app's one
// caller anchors the card to a table cell, so the test uses Base UI's own.
import { PreviewCard } from "@base-ui/react/preview-card";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { HoverCard, HoverCardContent } from "./hover-card";

afterEach(cleanup);

const WHOLE =
  "Watches the release branch and cuts a tag when every required check passes";

function renderCard() {
  return render(
    <HoverCard>
      <PreviewCard.Trigger href="#release-bot" delay={0} closeDelay={0}>
        release-bot
      </PreviewCard.Trigger>
      <HoverCardContent>{WHOLE}</HoverCardContent>
    </HoverCard>,
  );
}

/** The open card, found by the content it shows. */
async function openCard(): Promise<HTMLElement> {
  const text = await screen.findByText(WHOLE);
  const card = text.closest<HTMLElement>("[data-slot='hover-card-content']");
  if (card === null) throw new Error("the content sits in the card");
  return card;
}

describe("HoverCard", () => {
  it("shows nothing until the pointer or the keyboard reaches the trigger", () => {
    renderCard();
    expect(screen.queryByText(WHOLE)).toBeNull();
  });

  it("opens when the pointer rests on the trigger", async () => {
    renderCard();
    await userEvent.hover(screen.getByRole("link", { name: "release-bot" }));
    const card = await openCard();
    expect(card).toHaveTextContent(WHOLE);
    await expectNoAxe(document.body);
  });

  it("opens when the keyboard reaches the trigger", async () => {
    renderCard();
    await userEvent.tab();
    const trigger = screen.getByRole("link", { name: "release-bot" });
    expect(trigger).toHaveFocus();
    const card = await openCard();
    expect(card).toHaveTextContent(WHOLE);
    await expectNoAxe(document.body);
  });
});
