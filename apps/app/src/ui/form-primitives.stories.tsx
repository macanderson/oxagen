import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { buttonSecondary, panel } from "./control-styles";
import { Field, PasswordField } from "./field";
import { FormAlert, OutcomePanel, SubmitButton } from "./form-feedback";
import { TabList, TabPanel } from "./tabs";

const meta = {
  title: "Mission Control/Form primitives",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fields: Story = {
  render: () => (
    <form className={`${panel} flex max-w-md flex-col gap-4 p-5`}>
      <Field
        id="story-email"
        name="email"
        label="Work email"
        type="email"
        hint="The address your organization invited."
      />
      <Field
        id="story-slug"
        name="slug"
        label="Slug"
        defaultValue="Acme Robotics"
        error="Use lowercase letters, digits and hyphens."
      />
      <PasswordField
        id="story-password"
        name="password"
        label="Password"
        showLabel="Show"
        hideLabel="Hide"
      />
      <SubmitButton pending={false} label="Log in" pendingLabel="Logging in" />
    </form>
  ),
};

export const Feedback: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-4">
      <FormAlert>That email and password do not match an account.</FormAlert>
      <SubmitButton pending label="Log in" pendingLabel="Logging in" />
      <OutcomePanel
        tone="deny"
        title="This invitation was revoked"
        testId="story-outcome"
        actions={
          <a href="#login" className={buttonSecondary}>
            Log in
          </a>
        }
      >
        Ask the person who invited you to send a new one.
      </OutcomePanel>
    </div>
  ),
};

function TabsDemo() {
  const [value, setValue] = useState<"macos" | "windows" | "linux">("macos");
  return (
    <div className="max-w-md">
      <TabList
        label="Platform"
        idPrefix="story-platform"
        items={[
          { id: "macos", label: "macOS" },
          { id: "windows", label: "Windows" },
          { id: "linux", label: "Linux" },
        ]}
        value={value}
        onChange={setValue}
        className="flex gap-1 border-b border-tab-border"
        tabClassName={(selected) =>
          `-mb-px border-b-2 px-2.5 py-1.5 text-sm ${
            selected
              ? "border-tab-border-active text-tab-fg-active"
              : "border-transparent text-tab-fg"
          }`
        }
      />
      <TabPanel idPrefix="story-platform" value={value} className="p-3 text-sm">
        The {value} installer carries the one-time enrollment token.
      </TabPanel>
    </div>
  );
}

export const Tabs: Story = { render: () => <TabsDemo /> };
