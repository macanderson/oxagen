import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroupLabel,
  MenuSeparator,
  MenuShortcut,
} from "./menu";
import { Button } from "./button";

const meta = {
  title: "Overlays/Menu",
  component: Menu,
} satisfies Meta<typeof Menu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Menu>
      <MenuTrigger render={<Button variant="outline">Open menu</Button>} />
      <MenuPopup>
        <MenuGroupLabel>My account</MenuGroupLabel>
        <MenuItem onClick={() => {}}>
          Profile
          <MenuShortcut>⇧⌘P</MenuShortcut>
        </MenuItem>
        <MenuItem onClick={() => {}}>
          Settings
          <MenuShortcut>⌘,</MenuShortcut>
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => {}}>Log out</MenuItem>
      </MenuPopup>
    </Menu>
  ),
};
