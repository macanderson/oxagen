import type { Meta, StoryObj } from "@storybook/react-vite";
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

// Render bodies live in named components so the `useState` hook satisfies the
// rules-of-hooks lint (a hook may only run inside a component, not a bare
// `render` arrow).
function DefaultStory() {
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
}

function OpenByDefaultStory() {
  const [open, setOpen] = React.useState(true);
  return (
    <SchemaAssistantDrawer
      open={open}
      onOpenChange={setOpen}
      slugs={{ orgSlug: "acme", workspaceSlug: "main" }}
    />
  );
}

export const Default: Story = {
  render: () => <DefaultStory />,
};

export const OpenByDefault: Story = {
  render: () => <OpenByDefaultStory />,
};
