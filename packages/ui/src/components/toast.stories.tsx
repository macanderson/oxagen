import * as React from "react";
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

/**
 * Enqueues one toast of each type on mount, so the toast surfaces and the
 * ToastViewport's stacking are visible in the catalog and verifiable by
 * design-sync's screenshot oracle. `Default` is interaction-driven and only
 * ever proves the three trigger buttons render.
 *
 * `timeout: 0` disables auto-dismiss so the story is deterministic — a
 * screenshot taken at any moment shows the same three toasts.
 */
function OpenDemo() {
  const toast = useToast();
  const fired = React.useRef(false);
  React.useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    toast.add({
      title: "Saved",
      description: "Your changes are live.",
      timeout: 0,
    });
    toast.add({
      title: "Synced",
      description: "Workspace up to date.",
      type: "success",
      timeout: 0,
    });
    toast.add({
      title: "Failed",
      description: "Could not reach the API.",
      type: "error",
      timeout: 0,
    });
  }, [toast]);
  return <Demo />;
}

export const Open: Story = {
  render: () => (
    <ToastProvider>
      <OpenDemo />
      <ToastViewport />
    </ToastProvider>
  ),
};
