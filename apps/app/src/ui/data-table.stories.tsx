import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { Money as MoneyValue } from "@/data/contracts/common";
import { DataTable, type DataTableColumn } from "./data-table";
import { Money } from "./money";
import { StatusBadge } from "./status-badge";
import { TierBadge } from "./tier-badge";
import type { RunStatus } from "@/data/contracts";

type RunRow = {
  id: string;
  agent: string;
  status: RunStatus;
  tier: "gateway" | "harness" | "observe";
  cost: MoneyValue;
};

const statuses: RunStatus[] = ["live", "sealed", "parked", "halted", "sealed"];
const tiers = ["gateway", "gateway", "harness", "observe"] as const;

const rows: RunRow[] = Array.from({ length: 23 }, (_, i) => ({
  id: `run_01K5R${String(i).padStart(3, "0")}`,
  agent:
    [
      "acme.core.release-manager",
      "acme.core.dep-bumper",
      "acme.finops.reporter",
    ][i % 3] ?? "",
  status: statuses[i % statuses.length] ?? "sealed",
  tier: tiers[i % tiers.length] ?? "gateway",
  cost: {
    micros: String((i * 713 + 97) * 10_000),
    currency: "USD",
    basis: "gateway_observed",
  },
}));

const columns: DataTableColumn<RunRow>[] = [
  {
    id: "run",
    header: "Run",
    cell: (r) => <span className="font-mono text-xs">{r.id}</span>,
    sortValue: (r) => r.id,
    searchValue: (r) => `${r.id} ${r.agent}`,
  },
  {
    id: "agent",
    header: "Agent",
    cell: (r) => r.agent,
    sortValue: (r) => r.agent,
  },
  {
    id: "status",
    header: "Status",
    cell: (r) => <StatusBadge status={r.status} />,
    facetValue: (r) => r.status,
  },
  {
    id: "tier",
    header: "Tier",
    cell: (r) => <TierBadge tier={r.tier} />,
    facetValue: (r) => r.tier,
  },
  {
    id: "cost",
    header: "Cost",
    cell: (r) => <Money value={r.cost} />,
    sortValue: (r) => BigInt(r.cost.micros),
    align: "end",
  },
];

function RunsTable(props: { withControls: boolean; empty?: boolean }) {
  return (
    <DataTable
      rows={props.empty ? [] : rows}
      columns={columns}
      getRowId={(r) => r.id}
      caption="Runs in core-platform"
      {...(props.withControls
        ? { search: { placeholder: "Search runs" }, pageSizes: [10, 25, 0] }
        : {})}
      {...(props.empty
        ? {
            empty: (
              <p className="text-sm text-muted-foreground">No runs yet.</p>
            ),
          }
        : {})}
    />
  );
}

const meta = {
  title: "Mission Control/DataTable",
  component: RunsTable,
  tags: ["autodocs"],
  args: { withControls: true },
} satisfies Meta<typeof RunsTable>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithEveryControl: Story = {};

export const ControlsOmitted: Story = { args: { withControls: false } };

export const NoRows: Story = { args: { empty: true } };
