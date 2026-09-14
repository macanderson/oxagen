import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Meter } from "./meter";
import { Money } from "./money";
import { PageHeader } from "./page-header";
import { Sparkline } from "./sparkline";
import { StatusBadge } from "./status-badge";
import { TierBadge } from "./tier-badge";
import { Tile } from "./tile";

const meta = {
  title: "Mission Control/Tiles, meters and sparklines",
  tags: ["autodocs"],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const daily = [
  41, 38, 44, 52, 17, 12, 47, 49, 51, 58, 55, 20, 14, 61, 63, 59, 66, 70, 22,
  18, 72, 69, 74, 77, 80, 25, 21, 83, 81, 86,
];

export const Tiles: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile
        label="Spend · September"
        value={
          <Money
            value={{
              micros: "2450000000",
              currency: "USD",
              basis: "gateway_observed",
            }}
            showBasis={false}
          />
        }
        sub="gateway_observed · USD"
        chart={<Sparkline points={daily} label="Spend per day, last 30 days" />}
      />
      <Tile label="Runs" value="1,204" sub="38 live" />
      <Tile label="Proven" value="61%" sub="of sealed runs" />
      <Tile
        label="Cache hit rate"
        value="74%"
        chart={
          <Meter label="Cache hit rate" value={74} max={100} valueText="74%" />
        }
      />
    </div>
  ),
};

export const Meters: Story = {
  render: () => (
    <div className="flex max-w-md flex-col gap-3">
      <Meter
        label="Marcus Bell"
        value={1204000000n}
        max={2450000000n}
        valueText="$1,204.00 · 49%"
        showText
      />
      <Meter
        label="Priya Nair"
        value={830000000n}
        max={2450000000n}
        valueText="$830.00 · 34%"
        showText
      />
      <Meter
        label="Dana Okafor"
        value={1n}
        max={2450000000n}
        valueText="$0.00 · 0%"
        showText
      />
    </div>
  ),
};

export const SparklineWithHoverLabels: Story = {
  render: () => (
    <div className="max-w-md">
      <Sparkline
        points={daily.slice(0, 7)}
        label="Spend per day, last 7 days"
        pointLabels={daily
          .slice(0, 7)
          .map((v, i) => `Sep ${String(i + 5)} · $${String(v)}`)}
      />
    </div>
  ),
};

export const HeaderWithLargeCost: Story = {
  render: () => (
    <PageHeader
      eyebrow="Run · run_01K5RS8Q"
      title="Refetch a stable list"
      figure={
        <Money
          variant="large"
          value={{
            micros: "4131265",
            currency: "USD",
            basis: "gateway_observed",
          }}
        />
      }
      description="acme.core.release-manager on behalf of Marcus Bell"
      meta={
        <>
          <StatusBadge status="sealed" />
          <TierBadge tier="gateway" />
        </>
      }
      actions={
        <button
          type="button"
          className="h-8 rounded-md border border-button-default-border px-3 text-sm"
        >
          Export
        </button>
      }
    />
  ),
};
