import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import {
  emptyConditionGroup,
  type ConditionNode,
  type ConditionGroup,
} from "@oxagen/oxagen/trigger-conditions";
import type { PropertyItem } from "@/components/knowledge/schema-builder/types";
import { ConditionBuilder } from "./condition-builder";

const meta: Meta<typeof ConditionBuilder> = {
  title: "Automations/ConditionBuilder",
  component: ConditionBuilder,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ConditionBuilder>;

// A representative "PullRequest" label's schema properties.
const PROPERTIES: PropertyItem[] = [
  {
    key: "status",
    dataType: "enum",
    required: true,
    enumValues: ["open", "merged", "closed"],
  },
  {
    key: "priority",
    dataType: "enum",
    required: false,
    enumValues: ["P0", "P1", "P2", "P3"],
  },
  { key: "title", dataType: "string", required: true },
  { key: "additions", dataType: "number", required: false },
  { key: "draft", dataType: "boolean", required: false },
  { key: "merged_at", dataType: "datetime", required: false },
];

/** Stateful wrapper — the builder is controlled, so a story needs local state. */
function Stateful({
  initial,
  disabled,
  properties = PROPERTIES,
}: {
  initial: ConditionNode;
  disabled?: boolean;
  properties?: PropertyItem[];
}) {
  const [value, setValue] = React.useState<ConditionNode>(initial);
  return (
    <div className="max-w-2xl">
      <ConditionBuilder
        value={value}
        onChange={setValue}
        properties={properties}
        disabled={disabled}
      />
      <pre className="mt-4 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground overflow-x-auto">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export const Empty: Story = {
  render: () => <Stateful initial={emptyConditionGroup("and")} />,
};

/** `status = merged AND (priority = P0 OR priority = P1)` — the flagship "1 AND (2 OR 3)". */
export const NestedTree: Story = {
  render: () => {
    const tree: ConditionGroup = {
      kind: "group",
      id: "root",
      combinator: "and",
      children: [
        {
          kind: "condition",
          id: "c1",
          property: "status",
          operator: "eq",
          value: "merged",
        },
        {
          kind: "group",
          id: "g1",
          combinator: "or",
          children: [
            {
              kind: "condition",
              id: "c2",
              property: "priority",
              operator: "eq",
              value: "P0",
            },
            {
              kind: "condition",
              id: "c3",
              property: "priority",
              operator: "eq",
              value: "P1",
            },
          ],
        },
      ],
    };
    return <Stateful initial={tree} />;
  },
};

/** `priority is any of [P0, P1]` — the multi-select value control for in/not_in. */
export const MultiSelectEnum: Story = {
  render: () => {
    const tree: ConditionGroup = {
      kind: "group",
      id: "root",
      combinator: "and",
      children: [
        {
          kind: "condition",
          id: "c1",
          property: "priority",
          operator: "in",
          value: ["P0", "P1"],
        },
      ],
    };
    return <Stateful initial={tree} />;
  },
};

export const Disabled: Story = {
  render: () => {
    const tree: ConditionGroup = {
      kind: "group",
      id: "root",
      combinator: "and",
      children: [
        {
          kind: "condition",
          id: "c1",
          property: "status",
          operator: "eq",
          value: "open",
        },
      ],
    };
    return <Stateful initial={tree} disabled />;
  },
};
