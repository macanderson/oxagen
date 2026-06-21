import type { Meta, StoryObj } from "@storybook/react-vite";
import { RadioGroup, Radio } from "./radio-group";
import { Label } from "./label";

const meta = {
  title: "Forms/RadioGroup",
  component: RadioGroup,
} satisfies Meta<typeof RadioGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <RadioGroup defaultValue="comfortable">
      {[
        ["default", "Default"],
        ["comfortable", "Comfortable"],
        ["compact", "Compact"],
      ].map(([value, label]) => (
        <div key={value} className="flex items-center gap-2">
          <Radio id={value} value={value} />
          <Label htmlFor={value}>{label}</Label>
        </div>
      ))}
    </RadioGroup>
  ),
};
