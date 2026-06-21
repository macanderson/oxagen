import type { Meta, StoryObj } from "@storybook/react-vite";
import { Label } from "./label";
import { Input } from "./input";

const meta = {
  title: "Forms/Label",
  component: Label,
  args: { children: "Email address" },
} satisfies Meta<typeof Label>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithInput: Story = {
  render: () => (
    <div className="flex max-w-xs flex-col gap-1.5">
      <Label htmlFor="name">Full name</Label>
      <Input id="name" placeholder="Ada Lovelace" />
    </div>
  ),
};
