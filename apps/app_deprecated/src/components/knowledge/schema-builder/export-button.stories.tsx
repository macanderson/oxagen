import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import { ExportButton } from "./export-button";

const meta: Meta<typeof ExportButton> = {
  title: "Knowledge/SchemaBuilder/ExportButton",
  component: ExportButton,
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof ExportButton>;

export const Default: Story = {
  render: () => (
    <ExportButton slugs={{ orgSlug: "acme", workspaceSlug: "main" }} />
  ),
};

export const WithVersionId: Story = {
  render: () => (
    <ExportButton
      slugs={{ orgSlug: "acme", workspaceSlug: "main" }}
      versionId="ver_01"
    />
  ),
};
