import type { Meta, StoryObj } from "@storybook/react-vite";
import { Separator } from "./separator";

const meta = {
  title: "Primitives/Separator",
  component: Separator,
} satisfies Meta<typeof Separator>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <div className="max-w-xs">
      <p className="text-base">Section one</p>
      <Separator className="my-3" />
      <p className="text-base">Section two</p>
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className="flex h-8 items-center gap-3 text-base">
      <span>Docs</span>
      <Separator orientation="vertical" />
      <span>API</span>
      <Separator orientation="vertical" />
      <span>Guides</span>
    </div>
  ),
};
