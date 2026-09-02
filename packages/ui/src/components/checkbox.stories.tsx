import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Checkbox } from "./checkbox";
import { Label } from "./label";

const meta = {
  title: "Forms/Checkbox",
  component: Checkbox,
} satisfies Meta<typeof Checkbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [checked, setChecked] = React.useState(true);
    return (
      <div className="flex items-center gap-2">
        <Checkbox
          id="terms"
          checked={checked}
          onCheckedChange={(v) => setChecked(Boolean(v))}
        />
        <Label htmlFor="terms">Accept terms and conditions</Label>
      </div>
    );
  },
};

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Checkbox id="a" defaultChecked />
        <Label htmlFor="a">Checked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="b" />
        <Label htmlFor="b">Unchecked</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="c" disabled defaultChecked />
        <Label htmlFor="c">Disabled</Label>
      </div>
    </div>
  ),
};
