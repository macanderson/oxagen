import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Sheet,
  SheetTrigger,
  SheetPopup,
  SheetHeader,
  SheetPanel,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from "./sheet";
import { Button } from "./button";

const meta = {
  title: "Overlays/Sheet",
  component: Sheet,
} satisfies Meta<typeof Sheet>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Right: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger render={<Button variant="outline">Open sheet</Button>} />
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>
            Adjust your workspace preferences.
          </SheetDescription>
        </SheetHeader>
        <SheetPanel>
          <p className="text-sm text-muted-foreground">Sheet body content.</p>
        </SheetPanel>
        <SheetFooter>
          <SheetClose render={<Button>Done</Button>} />
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  ),
};

/**
 * Open by default, so the sheet popup, header, body and footer are visible in
 * the catalog and verifiable by design-sync's oracle.
 */
export const RightOpen: Story = {
  render: () => (
    <Sheet defaultOpen>
      <SheetTrigger render={<Button variant="outline">Open sheet</Button>} />
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>
            Adjust your workspace preferences.
          </SheetDescription>
        </SheetHeader>
        <SheetPanel>
          <p className="text-sm text-muted-foreground">Sheet body content.</p>
        </SheetPanel>
        <SheetFooter>
          <SheetClose render={<Button>Done</Button>} />
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  ),
};
