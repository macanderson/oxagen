import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import { LabelEditor } from "./label-editor";

const meta: Meta<typeof LabelEditor> = {
  title: "Knowledge/SchemaBuilder/LabelEditor",
  component: LabelEditor,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof LabelEditor>;

export const NewLabel: Story = {
  render: () => (
    <LabelEditor
      schemaName="core"
      onSave={async (input) => {
        console.log("Saved:", input);
      }}
      onCancel={() => console.log("Cancelled")}
    />
  ),
};

export const EditExisting: Story = {
  render: () => (
    <LabelEditor
      schemaName="core"
      initial={{
        name: "Person",
        displayName: "Person",
        description: "A human individual",
        naturalKeyProps: ["email"],
        properties: [
          {
            key: "name",
            dataType: "string",
            required: true,
            description: "Full name",
          },
          { key: "email", dataType: "email", required: false },
        ],
      }}
      onSave={async (input) => {
        console.log("Saved:", input);
      }}
      onCancel={() => console.log("Cancelled")}
    />
  ),
};
