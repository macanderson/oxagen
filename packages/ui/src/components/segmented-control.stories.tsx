import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SegmentedControl, SegmentedControlItem } from "./segmented-control";

const meta = {
  title: "Forms/SegmentedControl",
  component: SegmentedControl,
} satisfies Meta<typeof SegmentedControl>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [value, setValue] = React.useState("medium");
    return (
      <SegmentedControl value={value} onValueChange={setValue}>
        <SegmentedControlItem value="small">Small</SegmentedControlItem>
        <SegmentedControlItem value="medium">Medium</SegmentedControlItem>
        <SegmentedControlItem value="large">Large</SegmentedControlItem>
      </SegmentedControl>
    );
  },
};
