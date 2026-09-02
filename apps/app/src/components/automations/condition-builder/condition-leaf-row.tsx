"use client";
/**
 * condition-leaf-row.tsx — one comparison row: [n] property · operator · value.
 *
 * Property / operator / value are all schema-driven:
 *   - property: a Select over the watched label's properties, listed by their
 *     schema `key` (the same token the saved condition stores),
 *   - operator: a Select filtered by `operatorsForDataType(property.dataType)`,
 *   - value: rendered per the property's dataType — enum → Select of enumValues
 *     (single, or multi-checkbox for in/not_in), boolean → true/false Select,
 *     number/integer → number input, date/datetime → date input, else text.
 *     Hidden entirely for unary operators (changed/exists/not_exists).
 *
 * Pure & controlled — no data fetching. Emits a whole new leaf via onChange.
 */
import * as React from "react";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectPopup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import {
  operatorsForDataType,
  operatorRequiresValue,
  operatorExpectsArray,
  OPERATOR_LABELS,
  type ConditionLeaf,
  type ConditionOperator,
  type ConditionValue,
} from "@oxagen/oxagen/trigger-conditions";
import type { PropertyItem } from "@/components/knowledge/schema-builder/types";

interface ConditionLeafRowProps {
  leaf: ConditionLeaf;
  /** 1-based display number for the "1 AND 2" logic readout. */
  index: number;
  /** Properties of the currently-selected entity label. */
  properties: PropertyItem[];
  onChange: (next: ConditionLeaf) => void;
  onRemove: () => void;
  disabled?: boolean;
}

function propertyByKey(
  properties: PropertyItem[],
  key: string,
): PropertyItem | undefined {
  return properties.find((p) => p.key === key);
}

/**
 * When the property (and thus its dataType) changes, the current operator may no
 * longer be valid — snap to the first operator the new dataType offers.
 */
function coerceOperator(
  current: ConditionOperator,
  dataType: string | undefined,
): ConditionOperator {
  const allowed = operatorsForDataType(dataType);
  return allowed.includes(current)
    ? current
    : (allowed[0] as ConditionOperator);
}

export function ConditionLeafRow({
  leaf,
  index,
  properties,
  onChange,
  onRemove,
  disabled,
}: ConditionLeafRowProps): React.ReactElement {
  const property = propertyByKey(properties, leaf.property);
  const dataType = property?.dataType;
  const operators = operatorsForDataType(dataType);
  const showValue = operatorRequiresValue(leaf.operator);
  const wantsArray = operatorExpectsArray(leaf.operator);

  const handlePropertyChange = (key: string): void => {
    const nextProp = propertyByKey(properties, key);
    const nextOperator = coerceOperator(leaf.operator, nextProp?.dataType);
    onChange({
      ...leaf,
      property: key,
      operator: nextOperator,
      // Reset value on property change — the type space changed.
      value: operatorRequiresValue(nextOperator)
        ? operatorExpectsArray(nextOperator)
          ? []
          : ""
        : undefined,
    });
  };

  const handleOperatorChange = (op: ConditionOperator): void => {
    const nextArray = operatorExpectsArray(op);
    const wasArray = operatorExpectsArray(leaf.operator);
    let nextValue: ConditionValue | undefined = leaf.value;
    if (!operatorRequiresValue(op)) {
      nextValue = undefined;
    } else if (nextArray && !wasArray) {
      nextValue = [];
    } else if (!nextArray && wasArray) {
      nextValue = "";
    } else if (nextValue === undefined) {
      nextValue = nextArray ? [] : "";
    }
    onChange({ ...leaf, operator: op, value: nextValue });
  };

  const setValue = (value: ConditionValue): void => {
    onChange({ ...leaf, value });
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid={`condition-leaf-${leaf.id}`}
    >
      <span
        className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground"
        aria-label={`Condition ${index}`}
        data-testid={`leaf-number-${leaf.id}`}
      >
        {index}
      </span>

      {/* Property */}
      <div className="min-w-40 flex-1">
        <Select
          value={leaf.property !== "" ? leaf.property : undefined}
          onValueChange={(v) => {
            if (v !== null) handlePropertyChange(v as string);
          }}
          disabled={disabled}
          items={properties.map((p) => ({
            value: p.key,
            label: p.key,
          }))}
        >
          <SelectTrigger
            aria-label="Property"
            data-testid={`leaf-property-${leaf.id}`}
          >
            <SelectValue placeholder="Property" />
          </SelectTrigger>
          <SelectPopup>
            {properties.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.key}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {/* Operator */}
      <div className="min-w-36 flex-1">
        <Select
          value={leaf.operator}
          onValueChange={(v) => {
            if (v !== null) handleOperatorChange(v as ConditionOperator);
          }}
          disabled={disabled || leaf.property === ""}
          items={operators.map((op) => ({
            value: op,
            label: OPERATOR_LABELS[op],
          }))}
        >
          <SelectTrigger
            aria-label="Operator"
            data-testid={`leaf-operator-${leaf.id}`}
          >
            <SelectValue placeholder="Operator" />
          </SelectTrigger>
          <SelectPopup>
            {operators.map((op) => (
              <SelectItem key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {/* Value */}
      {showValue && (
        <div className="min-w-40 flex-1">
          <LeafValueControl
            leaf={leaf}
            property={property}
            wantsArray={wantsArray}
            disabled={disabled}
            onValueChange={setValue}
          />
        </div>
      )}

      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
        aria-label={`Remove condition ${index}`}
        data-testid={`leaf-remove-${leaf.id}`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

// ── Value control ────────────────────────────────────────────────────────────

interface LeafValueControlProps {
  leaf: ConditionLeaf;
  property: PropertyItem | undefined;
  wantsArray: boolean;
  disabled?: boolean;
  onValueChange: (value: ConditionValue) => void;
}

function LeafValueControl({
  leaf,
  property,
  wantsArray,
  disabled,
  onValueChange,
}: LeafValueControlProps): React.ReactElement {
  const dataType = property?.dataType;

  // enum — Select of enumValues (multi-checkbox for in/not_in).
  if (dataType === "enum") {
    const enumValues = property?.enumValues ?? [];
    if (wantsArray) {
      return (
        <EnumMultiSelect
          leaf={leaf}
          enumValues={enumValues}
          disabled={disabled}
          onValueChange={onValueChange}
        />
      );
    }
    const current = typeof leaf.value === "string" ? leaf.value : undefined;
    return (
      <Select
        value={current !== "" ? current : undefined}
        onValueChange={(v) => {
          if (v !== null) onValueChange(v as string);
        }}
        disabled={disabled}
        items={enumValues.map((v) => ({ value: v, label: v }))}
      >
        <SelectTrigger aria-label="Value" data-testid={`leaf-value-${leaf.id}`}>
          <SelectValue placeholder="Value" />
        </SelectTrigger>
        <SelectPopup>
          {enumValues.map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  }

  // boolean — true / false Select.
  if (dataType === "boolean") {
    const current =
      typeof leaf.value === "boolean" ? String(leaf.value) : undefined;
    return (
      <Select
        value={current}
        onValueChange={(v) => {
          if (v !== null) onValueChange(v === "true");
        }}
        disabled={disabled}
        items={[
          { value: "true", label: "true" },
          { value: "false", label: "false" },
        ]}
      >
        <SelectTrigger aria-label="Value" data-testid={`leaf-value-${leaf.id}`}>
          <SelectValue placeholder="Value" />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectPopup>
      </Select>
    );
  }

  // number / integer — number input.
  if (dataType === "number" || dataType === "integer") {
    const current =
      typeof leaf.value === "number"
        ? String(leaf.value)
        : typeof leaf.value === "string"
          ? leaf.value
          : "";
    return (
      <Input
        type="number"
        inputMode="numeric"
        value={current}
        placeholder="Value"
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          onValueChange(raw === "" ? "" : Number(raw));
        }}
        data-testid={`leaf-value-${leaf.id}`}
      />
    );
  }

  // date / datetime — date input.
  if (dataType === "date" || dataType === "datetime") {
    return (
      <Input
        type={dataType === "date" ? "date" : "datetime-local"}
        value={typeof leaf.value === "string" ? leaf.value : ""}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
        data-testid={`leaf-value-${leaf.id}`}
      />
    );
  }

  // default — free text (string / url / email / unknown).
  return (
    <Input
      value={typeof leaf.value === "string" ? leaf.value : ""}
      placeholder="Value"
      disabled={disabled}
      autoComplete="off"
      onChange={(e) => onValueChange(e.target.value)}
      data-testid={`leaf-value-${leaf.id}`}
    />
  );
}

// ── Enum multi-select (in / not_in) ──────────────────────────────────────────

interface EnumMultiSelectProps {
  leaf: ConditionLeaf;
  enumValues: string[];
  disabled?: boolean;
  onValueChange: (value: ConditionValue) => void;
}

function EnumMultiSelect({
  leaf,
  enumValues,
  disabled,
  onValueChange,
}: EnumMultiSelectProps): React.ReactElement {
  const selected = Array.isArray(leaf.value)
    ? leaf.value.map((v) => String(v))
    : [];

  const toggle = (value: string): void => {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onValueChange(next);
  };

  const summary =
    selected.length === 0 ? "Select values" : `${selected.length} selected`;

  return (
    <Popover>
      <PopoverTrigger
        className="flex h-8 w-full items-center justify-between rounded-md border border-input-border bg-input-bg px-3 text-sm text-input-fg hover:border-input-border-hover disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled}
        aria-label="Values"
        data-testid={`leaf-value-${leaf.id}`}
      >
        <span className="truncate">{summary}</span>
      </PopoverTrigger>
      <PopoverPopup className="w-48 p-1">
        <div className="max-h-56 space-y-0.5 overflow-y-auto">
          {enumValues.map((v) => (
            <label
              key={v}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
            >
              <Checkbox
                checked={selected.includes(v)}
                onCheckedChange={() => toggle(v)}
                data-testid={`leaf-value-${leaf.id}-opt-${v}`}
              />
              <span className="truncate">{v}</span>
            </label>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
