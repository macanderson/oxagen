import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToastProvider, ToastViewport, useToast } from "./toast";
import { Button } from "./button";

const meta = {
  title: "Overlays/Toast",
  component: ToastProvider,
} satisfies Meta<typeof ToastProvider>;
export default meta;
type Story = StoryObj<typeof meta>;

function Demo() {
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        onClick={() =>
          toast.add({ title: "Saved", description: "Your changes are live." })
        }
      >
        Default
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.add({
            title: "Synced",
            description: "Workspace up to date.",
            type: "success",
          })
        }
      >
        Success
      </Button>
      <Button
        variant="destructive"
        onClick={() =>
          toast.add({
            title: "Failed",
            description: "Could not reach the API.",
            type: "error",
          })
        }
      >
        Error
      </Button>
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <ToastProvider>
      <Demo />
      <ToastViewport />
    </ToastProvider>
  ),
};
