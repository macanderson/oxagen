import type { Meta, StoryObj } from "@storybook/react-vite";
import { Textarea } from "./textarea";
import { Label } from "./label";

const meta = {
  title: "Forms/Textarea",
  component: Textarea,
  argTypes: { size: { control: "select", options: ["sm", "default", "lg"] } },
  args: { placeholder: "Type your message…" },
} satisfies Meta<typeof Textarea>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => <Textarea {...args} className="max-w-sm" />,
};

export const WithLabel: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Label htmlFor="bio">Bio</Label>
      <Textarea id="bio" placeholder="Tell us about yourself" />
    </div>
  ),
};
