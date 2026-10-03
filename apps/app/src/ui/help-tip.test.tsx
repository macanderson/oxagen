// @vitest-environment jsdom
// A field's help (help-tip.tsx): a small gold "?" that names the field it
// helps, and opens its note on a pointer resting on it or on a press, so the
// note reaches a touch screen and a keyboard as well as a mouse.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { Field } from "./field";
import { HelpTip } from "./help-tip";

afterEach(cleanup);

const NOTE = "Oxagen uses the name as the workspace's slug.";

function renderField() {
  return render(
    <Field
      id="slug"
      name="slug"
      label="Name"
      help={
        <HelpTip label="Help for Name" testId="slug-help">
          {NOTE}
        </HelpTip>
      }
    />,
  );
}

describe("HelpTip", () => {
  it("draws the primary button's gold and ink, named for its field", () => {
    renderField();
    const help = screen.getByRole("button", { name: "Help for Name" });
    expect(help).toHaveClass("bg-button-primary-bg");
    expect(help).toHaveClass("text-button-primary-fg");
    // Beside the label, not inside it, so it is not part of the field's name.
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
    expect(help.closest("label")).toBeNull();
  });

  it("opens its note on a press, and the open note passes axe", async () => {
    renderField();
    expect(screen.queryByText(NOTE)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Help for Name" }));
    expect(await screen.findByTestId("slug-help-note")).toHaveTextContent(NOTE);
    await expectNoAxe(document.body);
  });

  it("opens its note when a pointer rests on it", async () => {
    renderField();
    await userEvent.hover(screen.getByRole("button", { name: "Help for Name" }));
    expect(await screen.findByTestId("slug-help-note")).toHaveTextContent(NOTE);
  });
});
