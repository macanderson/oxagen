import type { Meta, StoryObj } from "@storybook/react-vite";
import { Plus } from "lucide-react";
import { Button } from "./button";

const meta = {
  title: "Primitives/Button",
  component: Button,
  argTypes: {
    variant: {
      control: "select",
      options: [
        "primary",
        "default",
        "secondary",
        "outline",
        "ghost",
        "destructive",
        "destructive-outline",
        "link",
        "gradient",
      ],
    },
    size: {
      control: "select",
      options: [
        "xs",
        "sm",
        "default",
        "lg",
        "xl",
        "icon",
        "icon-sm",
        "icon-lg",
      ],
    },
    disabled: { control: "boolean" },
  },
  args: { children: "Button", variant: "default", size: "default" },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="destructive-outline">Destructive outline</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="xs">XS</Button>
      <Button size="sm">SM</Button>
      <Button size="default">Default</Button>
      <Button size="lg">LG</Button>
      <Button size="xl">XL</Button>
      <Button size="icon" aria-label="Add">
        <Plus />
      </Button>
    </div>
  ),
};

export const Disabled: Story = { args: { disabled: true } };

export const DisabledWithTooltip: Story = {
  args: {
    disabled: true,
    children: "Publish",
    disabledTooltip: "You need the Editor role to publish.",
  },
};
