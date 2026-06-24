import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import { VersionHistory } from "./version-history";

const meta: Meta<typeof VersionHistory> = {
  title: "Knowledge/SchemaBuilder/VersionHistory",
  component: VersionHistory,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof VersionHistory>;

export const Default: Story = {
  render: () => (
    <VersionHistory
      slugs={{ orgSlug: "acme", workspaceSlug: "main" }}
      pinnedVersionId="ver_01"
      onPin={async (versionId) => {
        console.log("Pinned:", versionId);
      }}
    />
  ),
};
