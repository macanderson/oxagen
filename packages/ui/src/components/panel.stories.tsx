import type { Meta, StoryObj } from "@storybook/react-vite";
import { Panel } from "./panel";
import { Button } from "./button";
import { Badge } from "./badge";

const meta = {
  title: "Surfaces/Panel",
  component: Panel,
} satisfies Meta<typeof Panel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Panel
      eyebrow="Workspace"
      title="General settings"
      actions={
        <Button size="sm" variant="outline">
          Edit
        </Button>
      }
      footer={<Button size="sm">Save changes</Button>}
      className="max-w-lg"
    >
      <p className="text-sm text-muted-foreground">
        The titled surface block for settings, detail views, and dashboards.
      </p>
      <div className="mt-3 flex gap-2">
        <Badge variant="success">Active</Badge>
        <Badge variant="muted">v0.4.0</Badge>
      </div>
    </Panel>
  ),
};
