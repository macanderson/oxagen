import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import { PropertyTable } from "./property-table";
import type { PropertyItem } from "./types";

const meta: Meta<typeof PropertyTable> = {
  title: "Knowledge/SchemaBuilder/PropertyTable",
  component: PropertyTable,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof PropertyTable>;

const SAMPLE_PROPS: PropertyItem[] = [
  {
    key: "name",
    dataType: "string",
    required: true,
    description: "Full name",
    example: "Alice",
  },
  {
    key: "email",
    dataType: "email",
    required: false,
    description: "Email address",
  },
  { key: "age", dataType: "integer", required: false },
];

function Controlled({
  initialProps = SAMPLE_PROPS,
  readOnly = false,
}: {
  initialProps?: PropertyItem[];
  readOnly?: boolean;
}) {
  const [props, setProps] = React.useState<PropertyItem[]>(initialProps);
  return (
    <PropertyTable
      properties={props}
      onAdd={(p) => setProps((prev) => [...prev, p])}
      onUpdate={(i, p) =>
        setProps((prev) => prev.map((x, idx) => (idx === i ? p : x)))
      }
      onRemove={(i) => setProps((prev) => prev.filter((_, idx) => idx !== i))}
      readOnly={readOnly}
    />
  );
}

export const Default: Story = {
  render: () => <Controlled />,
};

export const Empty: Story = {
  render: () => <Controlled initialProps={[]} />,
};

export const ReadOnly: Story = {
  render: () => <Controlled readOnly />,
};
