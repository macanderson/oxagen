import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  SelectGroup,
  SelectLabel,
} from "./select";

const meta = {
  title: "Forms/Select",
  component: Select,
} satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;

const FRUITS = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "blueberry", label: "Blueberry" },
  { value: "grapes", label: "Grapes" },
];

export const Default: Story = {
  render: () => (
    <div className="w-56">
      <Select items={FRUITS}>
        <SelectTrigger>
          <SelectValue placeholder="Select a fruit" />
        </SelectTrigger>
        <SelectPopup>
          <SelectGroup>
            <SelectLabel>Fruits</SelectLabel>
            {FRUITS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>
    </div>
  ),
};

/**
 * Open by default, so the popup, group label and item list are visible in the
 * catalog and verifiable by design-sync's screenshot oracle.
 */
export const Open: Story = {
  render: () => (
    <div className="w-56">
      <Select items={FRUITS} defaultOpen>
        <SelectTrigger>
          <SelectValue placeholder="Select a fruit" />
        </SelectTrigger>
        <SelectPopup>
          <SelectGroup>
            <SelectLabel>Fruits</SelectLabel>
            {FRUITS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>
    </div>
  ),
};
