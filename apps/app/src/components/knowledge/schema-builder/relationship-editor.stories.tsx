import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { RelationshipEditor } from "./relationship-editor";

const meta: Meta<typeof RelationshipEditor> = {
  title: "Knowledge/SchemaBuilder/RelationshipEditor",
  component: RelationshipEditor,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof RelationshipEditor>;

const LABELS = ["Person", "Organization", "Repository", "Contract"];

export const NewRelationship: Story = {
  render: () => (
    <RelationshipEditor
      schemaName="core"
      availableLabels={LABELS}
      onSave={async (input) => {
        console.log("Saved:", input);
      }}
      onCancel={() => console.log("Cancelled")}
    />
  ),
};

export const EditExisting: Story = {
  render: () => (
    <RelationshipEditor
      schemaName="core"
      availableLabels={LABELS}
      initial={{
        name: "WORKS_FOR",
        displayName: "Works For",
        startLabel: "Person",
        endLabel: "Organization",
        cardinality: "many_to_many",
        description: "Indicates employment relationship.",
      }}
      onSave={async (input) => {
        console.log("Saved:", input);
      }}
      onCancel={() => console.log("Cancelled")}
    />
  ),
};
