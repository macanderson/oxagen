import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { SchemaAssistantDrawer } from "./schema-assistant-drawer";
import { Button } from "@/components/ui/button";

const meta: Meta<typeof SchemaAssistantDrawer> = {
  title: "Knowledge/SchemaBuilder/SchemaAssistantDrawer",
  component: SchemaAssistantDrawer,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof SchemaAssistantDrawer>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = React.useState(false);
    return (
      <div className="p-8">
        <Button onClick={() => setOpen(true)}>Open Schema Assistant</Button>
        <SchemaAssistantDrawer
          open={open}
          onOpenChange={setOpen}
          slugs={{ orgSlug: "acme", workspaceSlug: "main" }}
        />
      </div>
    );
  },
};

export const OpenByDefault: Story = {
  render: () => {
    const [open, setOpen] = React.useState(true);
    return (
      <SchemaAssistantDrawer
        open={open}
        onOpenChange={setOpen}
        slugs={{ orgSlug: "acme", workspaceSlug: "main" }}
      />
    );
  },
};
