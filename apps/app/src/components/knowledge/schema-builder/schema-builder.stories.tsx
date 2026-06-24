import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import { SchemaBuilder } from "./schema-builder";

const meta: Meta<typeof SchemaBuilder> = {
  title: "Knowledge/SchemaBuilder/SchemaBuilder",
  component: SchemaBuilder,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof SchemaBuilder>;

export const Admin: Story = {
  render: () => (
    <SchemaBuilder
      slugs={{ orgSlug: "acme", workspaceSlug: "main" }}
      isAdmin={true}
    />
  ),
};

export const Viewer: Story = {
  render: () => (
    <SchemaBuilder
      slugs={{ orgSlug: "acme", workspaceSlug: "main" }}
      isAdmin={false}
    />
  ),
};
