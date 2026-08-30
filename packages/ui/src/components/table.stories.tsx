import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "./badge";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

const meta = {
  title: "Primitives/Table",
  component: Table,
} satisfies Meta<typeof Table>;
export default meta;
type Story = StoryObj<typeof meta>;

const rows = [
  {
    name: "ontology.query",
    calls: "18,204",
    status: "success",
    cost: "$42.10",
  },
  {
    name: "agent.code.execute",
    calls: "9,876",
    status: "warning",
    cost: "$120.44",
  },
  { name: "workflow.run", calls: "3,412", status: "success", cost: "$18.02" },
];

export const Default: Story = {
  render: () => (
    <Table containerClassName="rounded-xl border border-border">
      <TableHeader>
        <TableRow>
          <TableHead>Capability</TableHead>
          <TableHead className="text-right">Calls</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.name} interactive>
            <TableCell className="font-medium">{r.name}</TableCell>
            <TableCell className="text-right tabular-nums">{r.calls}</TableCell>
            <TableCell>
              <Badge
                variant={
                  r.status === "success" ? "success-soft" : "warning-soft"
                }
                dot
              >
                {r.status}
              </Badge>
            </TableCell>
            <TableCell className="text-right tabular-nums">{r.cost}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={3}>Total</TableCell>
          <TableCell className="text-right tabular-nums">$180.56</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
};

export const Compact: Story = {
  render: () => (
    <Table
      density="compact"
      containerClassName="rounded-xl border border-border"
    >
      <TableHeader>
        <TableRow>
          <TableHead>Capability</TableHead>
          <TableHead className="text-right">Calls</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.name}>
            <TableCell>{r.name}</TableCell>
            <TableCell className="text-right tabular-nums">{r.calls}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

export const Empty: Story = {
  render: () => (
    <Table containerClassName="rounded-xl border border-border">
      <TableHeader>
        <TableRow>
          <TableHead>Capability</TableHead>
          <TableHead className="text-right">Calls</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableEmpty colSpan={2}>No usage recorded yet</TableEmpty>
      </TableBody>
    </Table>
  ),
};
