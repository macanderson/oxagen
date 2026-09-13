// @vitest-environment jsdom
// The form primitives promoted from the sign-in and onboarding screens: a field
// wires its hint and error for assistive technology, the submit button reports
// pending without losing focus, the outcome panel names its tone, and Tabs move
// selection with the keyboard.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Field, PasswordField } from "./field";
import { FormAlert, OutcomePanel, SubmitButton } from "./form-feedback";
import { TabList, TabPanel } from "./tabs";

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

describe("Tabs", () => {
  function Harness() {
    const [value, setValue] = useState<"macos" | "windows" | "linux">("macos");
    return (
      <>
        <TabList
          label="Platform"
          idPrefix="platform"
          items={[
            { id: "macos", label: "macOS" },
            { id: "windows", label: "Windows" },
            { id: "linux", label: "Linux" },
          ]}
          value={value}
          onChange={setValue}
        />
        <TabPanel idPrefix="platform" value={value}>
          panel {value}
        </TabPanel>
      </>
    );
  }

  it("keeps only the selected tab in the tab order and labels the panel by it", () => {
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);
    expect(screen.getByRole("tabpanel", { name: "macOS" })).toHaveTextContent(
      "panel macos",
    );
  });

  it("moves and wraps selection with the arrow keys, Home and End", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("tab", { name: "macOS" }));
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Linux" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Linux" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "macOS" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("panel linux");
    await user.keyboard("{Home}");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("panel macos");
  });

  it("ignores keys that are not navigation (negative)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("tab", { name: "macOS" }));
    await user.keyboard("a{Enter}");
    expect(screen.getByRole("tab", { name: "macOS" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
