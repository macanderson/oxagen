// @vitest-environment jsdom
/**
 * condition-builder.test.tsx — the schema-driven nested condition builder.
 *
 * Covers:
 *   - renders the root combinator toggle + add buttons
 *   - "+ Add condition" appends a leaf and onChange emits a valid ConditionNode
 *   - "+ Add group" appends a nested group
 *   - removing a leaf drops it from the tree
 *   - toggling the combinator flips and/or
 *   - leaves are numbered 1..n across nesting
 *   - enum property renders a Select of its enumValues
 *   - disabled renders every control disabled
 *
 * UI primitives are mocked to native elements so interactions are drivable and
 * the test doesn't depend on Base UI portal/positioning internals.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  conditionNodeSchema,
  type ConditionGroup,
  type ConditionNode,
  type ConditionLeaf,
} from "@oxagen/oxagen/trigger-conditions";
import type { PropertyItem } from "@/components/knowledge/schema-builder/types";

afterEach(cleanup);

/** Narrow to a root group, failing the test otherwise. */
function asGroup(node: ConditionNode): ConditionGroup {
  if (node.kind !== "group") throw new Error("expected a group");
  return node;
}

/** Narrow the group's first child to a leaf. */
function firstLeaf(node: ConditionNode): ConditionLeaf {
  const group = asGroup(node);
  const child = group.children[0];
  if (!child || child.kind !== "condition") throw new Error("expected a leaf");
  return child;
}

// ── UI mocks ───────────────────────────────────────────────────────────────────

const SelectMockCtx = React.createContext<{
  onValueChange?: (v: string) => void;
}>({});
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    disabled,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <div data-disabled={disabled ? "true" : "false"} data-testid={testId}>
      <SelectMockCtx.Provider value={{ onValueChange }}>
        {children}
      </SelectMockCtx.Provider>
    </div>
  ),
  SelectTrigger: ({
    children,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    "data-testid"?: string;
  }) => <div data-testid={testId}>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => {
    const ctx = React.useContext(SelectMockCtx);
    return (
      <button
        type="button"
        data-select-value={value}
        onClick={() => ctx.onValueChange?.(value)}
      >
        {children}
      </button>
    );
  },
}));

vi.mock("@/components/ui/input", () => ({
  Input: (
    props: React.InputHTMLAttributes<HTMLInputElement> & {
      "data-testid"?: string;
    },
  ) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    ...rest
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <label {...rest}>{children}</label>
  ),
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    children,
    onValueChange,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
    "data-testid"?: string;
  }) => (
    <div data-testid={testId}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(
              child as React.ReactElement<{ onSelect?: (v: string) => void }>,
              {
                onSelect: onValueChange,
              },
            )
          : child,
      )}
    </div>
  ),
  SegmentedControlItem: ({
    children,
    value,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    value: string;
    onSelect?: (v: string) => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      data-combinator={value}
      onClick={() => onSelect?.(value)}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: (props: Record<string, unknown>) => (
    <input type="checkbox" {...props} />
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({
    children,
    ...rest
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Plus: () => <span data-testid="icon-plus" />,
    Trash2: () => <span data-testid="icon-trash" />,
    X: () => <span data-testid="icon-x" />,
  };
});

// Import AFTER mocks so the component picks up the mocked primitives.
import { ConditionBuilder } from "./condition-builder";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const PROPERTIES: PropertyItem[] = [
  {
    key: "status",
    dataType: "enum",
    required: false,
    enumValues: ["open", "won", "lost"],
  },
  { key: "count", dataType: "number", required: false },
  { key: "name", dataType: "string", required: false },
];

function emptyRoot(): ConditionGroup {
  return { kind: "group", id: "root", combinator: "and", children: [] };
}

/** Controlled harness: keeps builder state so add/remove/edit propagate. */
function Harness({
  initial,
  disabled,
  onChangeSpy,
}: {
  initial?: ConditionNode;
  disabled?: boolean;
  onChangeSpy?: (n: ConditionNode) => void;
}) {
  const [value, setValue] = React.useState<ConditionNode>(
    initial ?? emptyRoot(),
  );
  return (
    <ConditionBuilder
      value={value}
      onChange={(next) => {
        onChangeSpy?.(next);
        setValue(next);
      }}
      properties={PROPERTIES}
      disabled={disabled}
    />
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("ConditionBuilder", () => {
  it("renders the root combinator toggle and add buttons", () => {
    render(<Harness />);
    expect(screen.getByTestId("condition-builder")).toBeTruthy();
    expect(screen.getByTestId("group-combinator-root")).toBeTruthy();
    expect(screen.getByTestId("group-add-condition-root")).toBeTruthy();
    expect(screen.getByTestId("group-add-group-root")).toBeTruthy();
  });

  it("adds a condition and emits a well-formed ConditionNode tree", () => {
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    fireEvent.click(screen.getByTestId("group-add-condition-root"));

    const emitted = onChangeSpy.mock.calls.at(-1)?.[0] as ConditionNode;
    const group = asGroup(emitted);
    expect(group.children).toHaveLength(1);
    const leaf = firstLeaf(emitted);
    // Shape is correct; property is empty until the user picks one.
    expect(typeof leaf.id).toBe("string");
    expect(leaf.operator).toBe("eq");
  });

  it("emits a schema-valid tree once a property is selected on the new leaf", () => {
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    fireEvent.click(screen.getByTestId("group-add-condition-root"));
    const leafId = firstLeaf(
      onChangeSpy.mock.calls.at(-1)?.[0] as ConditionNode,
    ).id;

    // Pick the "name" property on the new leaf (the property Select's item).
    const row = screen.getByTestId(`condition-leaf-${leafId}`);
    fireEvent.click(
      row.querySelector('[data-select-value="name"]') as HTMLButtonElement,
    );
    const emitted = onChangeSpy.mock.calls.at(-1)?.[0] as ConditionNode;
    expect(() => conditionNodeSchema.parse(emitted)).not.toThrow();
  });

  it("adds a nested group", () => {
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    fireEvent.click(screen.getByTestId("group-add-group-root"));
    const emitted = onChangeSpy.mock.calls.at(-1)?.[0] as ConditionNode;
    expect(asGroup(emitted).children[0]?.kind).toBe("group");
  });

  it("removes a leaf", () => {
    const initial: ConditionGroup = {
      kind: "group",
      id: "root",
      combinator: "and",
      children: [
        {
          kind: "condition",
          id: "c1",
          property: "name",
          operator: "eq",
          value: "x",
        },
      ],
    };
    const onChangeSpy = vi.fn();
    render(<Harness initial={initial} onChangeSpy={onChangeSpy} />);
    fireEvent.click(screen.getByTestId("leaf-remove-c1"));
    const emitted = onChangeSpy.mock.calls.at(-1)?.[0] as ConditionNode;
    if (emitted.kind === "group") {
      expect(emitted.children).toHaveLength(0);
    }
  });

  it("toggles the root combinator from AND to OR", () => {
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    const orButton = screen
      .getByTestId("group-combinator-root")
      .querySelector('[data-combinator="or"]') as HTMLButtonElement;
    fireEvent.click(orButton);
    const emitted = onChangeSpy.mock.calls.at(-1)?.[0] as ConditionNode;
    if (emitted.kind === "group") {
      expect(emitted.combinator).toBe("or");
    }
  });

  it("numbers leaves 1..n across nesting", () => {
    const initial: ConditionGroup = {
      kind: "group",
      id: "root",
      combinator: "and",
      children: [
        {
          kind: "condition",
          id: "c1",
          property: "name",
          operator: "eq",
          value: "a",
        },
        {
          kind: "group",
          id: "g1",
          combinator: "or",
          children: [
            {
              kind: "condition",
              id: "c2",
              property: "name",
              operator: "eq",
              value: "b",
            },
            {
              kind: "condition",
              id: "c3",
              property: "name",
              operator: "eq",
              value: "c",
            },
          ],
        },
      ],
    };
    render(<Harness initial={initial} />);
    expect(screen.getByTestId("leaf-number-c1").textContent).toBe("1");
    expect(screen.getByTestId("leaf-number-c2").textContent).toBe("2");
    expect(screen.getByTestId("leaf-number-c3").textContent).toBe("3");
  });

  it("renders an enum property value as a Select of its enumValues", () => {
    const initial: ConditionGroup = {
      kind: "group",
      id: "root",
      combinator: "and",
      children: [
        {
          kind: "condition",
          id: "c1",
          property: "status",
          operator: "eq",
          value: "",
        },
      ],
    };
    render(<Harness initial={initial} />);
    // The enum value control renders each enumValue as a selectable item.
    const row = screen.getByTestId("condition-leaf-c1");
    expect(row.querySelector('[data-select-value="open"]')).toBeTruthy();
    expect(row.querySelector('[data-select-value="won"]')).toBeTruthy();
    expect(row.querySelector('[data-select-value="lost"]')).toBeTruthy();
  });

  it("hides the value control for unary operators (exists)", () => {
    const initial: ConditionGroup = {
      kind: "group",
      id: "root",
      combinator: "and",
      children: [
        { kind: "condition", id: "c1", property: "name", operator: "exists" },
      ],
    };
    render(<Harness initial={initial} />);
    expect(screen.queryByTestId("leaf-value-c1")).toBeNull();
  });

  it("disables the add buttons when disabled", () => {
    render(<Harness disabled />);
    expect(screen.getByTestId("group-add-condition-root")).toBeDisabled();
    expect(screen.getByTestId("group-add-group-root")).toBeDisabled();
  });
});
