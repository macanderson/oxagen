import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
} from "./popover";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";

const meta = {
  title: "Overlays/Popover",
  component: Popover,
} satisfies Meta<typeof Popover>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger
        render={<Button variant="outline">Open popover</Button>}
      />
      <PopoverPopup className="w-72">
        <PopoverTitle>Dimensions</PopoverTitle>
        <PopoverDescription>Set the layout dimensions.</PopoverDescription>
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="width" className="w-16">
              Width
            </Label>
            <Input id="width" defaultValue="100%" size="sm" />
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  ),
};
