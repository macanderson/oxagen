import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { PinChangeDialog } from "./pin-change-dialog";

const meta: Meta<typeof PinChangeDialog> = {
  title: "Knowledge/SchemaBuilder/PinChangeDialog",
  component: PinChangeDialog,
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof PinChangeDialog>;

export const Default: Story = {
  render: () => {
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
  },
};
