import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input } from "./input";
import { Label } from "./label";

const meta = {
  title: "Forms/Input",
  component: Input,
  argTypes: { size: { control: "select", options: ["sm", "default", "lg"] } },
  args: { placeholder: "you@example.com" },
} satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: () => (
    <div className="flex max-w-xs flex-col gap-3">
      <Input size="sm" placeholder="Small" />
      <Input size="default" placeholder="Default" />
      <Input size="lg" placeholder="Large (shadcn parity)" />
    </div>
  ),
};

export const WithLabel: Story = {
  render: () => (
    <div className="flex max-w-xs flex-col gap-1.5">
      <Label htmlFor="email">Email</Label>
      <Input id="email" type="email" placeholder="you@example.com" />
    </div>
  ),
};

export const Disabled: Story = { args: { disabled: true, value: "Disabled" } };
