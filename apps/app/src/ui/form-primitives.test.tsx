// @vitest-environment jsdom
// The form primitives promoted from the sign-in and organization screens: a field
// wires its hint and error for assistive technology, the submit button reports
// pending without losing focus, and the outcome panel names its tone.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Field, PasswordField } from "./field";
import { FormAlert, OutcomePanel, SubmitButton } from "./form-feedback";

afterEach(() => {
  cleanup();
});

describe("Field", () => {
  it("describes the input by its error and hint, and marks it invalid", () => {
    render(
      <Field
        id="email"
        name="email"
        label="Email"
        hint="Your work address"
        error="Enter an email"
      />,
    );
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      "Enter an email Your work address",
    );
    expect(screen.getByText("Enter an email")).toHaveClass("text-error-ink");
  });

  it("is not invalid and has no description without an error or hint (negative)", () => {
    render(<Field id="name" name="name" label="Name" />);
    const input = screen.getByLabelText("Name");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it("toggles a password between hidden and shown, announcing the state", async () => {
    const user = userEvent.setup();
    render(
      <PasswordField
        id="password"
        name="password"
        label="Password"
        showLabel="Show"
        hideLabel="Hide"
      />,
    );
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    const toggle = screen.getByRole("button", { name: "Show" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("form feedback", () => {
  it("announces an alert", () => {
    render(<FormAlert testId="alert">That did not work</FormAlert>);
    expect(screen.getByRole("alert")).toHaveTextContent("That did not work");
  });

  it("keeps a pending submit focusable and says what it is doing", () => {
    const { rerender } = render(
      <SubmitButton pending={false} label="Log in" pendingLabel="Logging in" />,
    );
    expect(screen.getByRole("button", { name: "Log in" })).not.toHaveAttribute(
      "aria-disabled",
    );
    rerender(<SubmitButton pending label="Log in" pendingLabel="Logging in" />);
    const pending = screen.getByRole("button", { name: "Logging in" });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).not.toBeDisabled();
  });

  // phone.css keys the 44px target on the attribute, so a submit inside its
  // own form carries it as much as one in a dialog footer does.
  it("is a touch target inside its form and outside it", () => {
    const { rerender } = render(
      <SubmitButton pending={false} label="Save" pendingLabel="Saving" />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "data-touch-target",
    );
    rerender(
      <SubmitButton
        pending={false}
        form="f1"
        label="Save"
        pendingLabel="Saving"
      />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "data-touch-target",
    );
  });

  it("is gold by default and gives the gold up when drawn as secondary", () => {
    const { rerender } = render(
      <SubmitButton pending={false} label="Link" pendingLabel="Linking" />,
    );
    expect(screen.getByRole("button", { name: "Link" }).className).toContain(
      "bg-button-primary-bg",
    );
    rerender(
      <SubmitButton
        pending={false}
        secondary
        label="Link"
        pendingLabel="Linking"
      />,
    );
    const secondary = screen.getByRole("button", { name: "Link" });
    expect(secondary.className).toContain("bg-button-default-bg");
    expect(secondary.className).not.toContain("bg-button-primary-bg");
  });

  it("titles an outcome panel as its region", () => {
    render(
      <OutcomePanel tone="deny" title="Invitation closed" testId="outcome">
        It was revoked.
      </OutcomePanel>,
    );
    expect(
      screen.getByRole("region", { name: "Invitation closed" }),
    ).toHaveTextContent("It was revoked.");
  });
});
