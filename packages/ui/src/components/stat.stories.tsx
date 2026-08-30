import type { Meta, StoryObj } from "@storybook/react-vite";
import { Coins, Gauge, ShieldCheck, Zap } from "lucide-react";
import { Stat, StatGroup } from "./stat";

const meta = {
  title: "Primitives/Stat",
  component: Stat,
} satisfies Meta<typeof Stat>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Group: Story = {
  args: { label: "", value: "" },
  render: () => (
    <StatGroup>
      <Stat
        label="Spend (MTD)"
        value="$1,204.55"
        delta="+12.4%"
        trend="up"
        intent="negative"
        icon={<Coins />}
        hint="vs last 30 days"
      />
      <Stat
        label="Tool calls"
        value="48,391"
        delta="+3.1%"
        trend="up"
        icon={<Zap />}
      />
      <Stat
        label="p95 latency"
        value="412ms"
        delta="-8.2%"
        trend="down"
        intent="positive"
        icon={<Gauge />}
      />
      <Stat
        label="Open findings"
        value="3"
        tone="warning"
        icon={<ShieldCheck />}
      />
    </StatGroup>
  ),
};

export const Loading: Story = {
  args: { label: "Spend (MTD)", value: "$0", loading: true },
};
