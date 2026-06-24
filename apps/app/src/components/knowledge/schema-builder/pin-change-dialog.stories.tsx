import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import { PinChangeDialog } from "./pin-change-dialog";

const meta: Meta<typeof PinChangeDialog> = {
  title: "Knowledge/SchemaBuilder/PinChangeDialog",
  component: PinChangeDialog,
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof PinChangeDialog>;

// Render body lives in a named component so the `useState` hook satisfies the
// rules-of-hooks lint (a hook may only run inside a component, not a bare
// `render` arrow).
function DefaultStory() {
  const [open, setOpen] = React.useState(true);
  return (
    <PinChangeDialog
      open={open}
      onOpenChange={setOpen}
      versionId="ver_02"
      versionNumber={2}
      onDispatch={async (opts) => {
        console.log("Dispatch:", opts);
        setOpen(false);
      }}
    />
  );
}

export const Default: Story = {
  render: () => <DefaultStory />,
};
