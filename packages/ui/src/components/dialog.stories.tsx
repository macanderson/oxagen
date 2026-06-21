import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "./dialog";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";

const meta = {
  title: "Overlays/Dialog",
  component: Dialog,
} satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Dialog>
      <DialogTrigger render={<Button>Edit profile</Button>} />
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
          <DialogDescription>
            Make changes to your profile here. Click save when you're done.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" defaultValue="Ada Lovelace" />
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost">Cancel</Button>} />
          <DialogClose render={<Button>Save changes</Button>} />
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  ),
};
