import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Switch } from "./switch";
import { Label } from "./label";

const meta = {
  title: "Forms/Switch",
  component: Switch,
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [on, setOn] = React.useState(true);
    return (
      <div className="flex items-center gap-2">
        <Switch id="notifications" checked={on} onCheckedChange={setOn} />
        <Label htmlFor="notifications">Enable notifications</Label>
      </div>
    );
  },
};

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Switch defaultChecked />
      <Switch />
      <Switch disabled defaultChecked />
    </div>
  ),
};
