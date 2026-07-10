import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusDot } from "./status-dot";

const meta = {
  title: "Primitives/StatusDot",
  component: StatusDot,
} satisfies Meta<typeof StatusDot>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Statuses: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <StatusDot status="success" label="Healthy" />
      <StatusDot status="info" pulse label="Running" />
      <StatusDot status="warning" label="Degraded" />
      <StatusDot status="error" label="Failed" />
      <StatusDot status="neutral" label="Idle" />
    </div>
  ),
};
