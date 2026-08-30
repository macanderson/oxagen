"use client";
/**
 * Combobox — searchable typeahead select built on Base UI's Combobox primitive.
 *
 * Use this instead of Select whenever the option list has more than 20 items
 * (country: 249, US state: 51, industry: 24). The UX rule:
 *   > 20 options → Combobox with typeahead search
 *   ≤ 20 options → plain Select
 *
 * Parts exported (shadcn-style naming conventions, coss popup naming):
 *   Combobox            — root (value/onValueChange/defaultValue/disabled)
 *   ComboboxTrigger     — the clickable trigger button (shows selected label)
 *   ComboboxValue       — renders the selected label (or placeholder)
 *   ComboboxPopup       — the animated overlay containing search + list
 *   ComboboxItem        — a single option row
 *
 * Usage:
 * ```tsx
 * <Combobox value={country} onValueChange={setCountry}>
 *   <ComboboxTrigger id="country" size="lg" className="w-full">
 *     <ComboboxValue placeholder="Select country" />
 *   </ComboboxTrigger>
 *   <ComboboxPopup searchPlaceholder="Search countries…">
 *     {COUNTRY_OPTIONS.map((o) => (
 *       <ComboboxItem key={o.value} value={o.value}>{o.label}</ComboboxItem>
 *     ))}
 *   </ComboboxPopup>
 * </Combobox>
 * ```
 */
import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "../lib/utils";

// ── Root ─────────────────────────────────────────────────────────────────────

/**
 * Root combobox context provider.
 * Accepts `value`, `onValueChange`, `defaultValue`, `disabled`, `name`.
 */
function Combobox<V = string>({
  children,
  value,
  onValueChange,
  defaultValue,
  disabled,
  name,
}: {
  children: React.ReactNode;
  value?: V | null;
  onValueChange?: (value: V | null) => void;
  defaultValue?: V | null;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <ComboboxPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      defaultValue={defaultValue}
      disabled={disabled}
      name={name}
    >
      {children}
    </ComboboxPrimitive.Root>
  );
}
Combobox.displayName = "Combobox";

// ── Trigger ──────────────────────────────────────────────────────────────────

// Mirrors the Select trigger: a real input surface via the --input-* tokens, so
// the field reads as a solid (dark-in-dark) field rather than a transparent
// cut-out that shows the page through.
const comboboxTriggerVariants = cva(
  "flex w-full items-center justify-between whitespace-nowrap rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-input-fg placeholder:text-input-placeholder hover:border-input-border-hover focus:outline-none focus:border-input-border-focus focus:ring-1 focus:ring-input-ring disabled:cursor-not-allowed disabled:bg-input-disabled-bg disabled:text-input-disabled-fg [&>span]:line-clamp-1",
  {
    variants: {
      size: {
        sm: "h-7",
        default: "h-8",
        lg: "h-9",
      },
    },
    defaultVariants: { size: "default" },
  },
);

interface ComboboxTriggerProps
  extends Omit<
      React.ComponentPropsWithoutRef<typeof ComboboxPrimitive.Trigger>,
      "size"
    >,
    VariantProps<typeof comboboxTriggerVariants> {}

const ComboboxTrigger = React.forwardRef<
  React.ComponentRef<typeof ComboboxPrimitive.Trigger>,
  ComboboxTriggerProps
>(({ className, size, children, ...props }, ref) => (
  <ComboboxPrimitive.Trigger
    ref={ref}
    className={cn(comboboxTriggerVariants({ size }), className)}
    {...props}
  >
    {children}
    <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
  </ComboboxPrimitive.Trigger>
));
ComboboxTrigger.displayName = "ComboboxTrigger";

// ── Value (selected label display) ───────────────────────────────────────────
// ComboboxValue is a non-ref, no-DOM component — it renders text into the
// trigger. It only accepts `placeholder` and `children` (from Base UI's API).

function ComboboxValue({ placeholder }: { placeholder?: string }) {
  return <ComboboxPrimitive.Value placeholder={placeholder} />;
}
ComboboxValue.displayName = "ComboboxValue";

// ── Popup ─────────────────────────────────────────────────────────────────────

interface ComboboxPopupProps {
  children: React.ReactNode;
  className?: string;
  searchPlaceholder?: string;
  sideOffset?: number;
  portalProps?: React.ComponentPropsWithoutRef<typeof ComboboxPrimitive.Portal>;
}

/**
 * Flatten a node tree to its searchable text. Walks nested elements and
 * fragments so an item whose label is wrapped (an icon plus text, a `<span>`,
 * an interpolated number) still matches the query — reading only the top level
 * would yield "" for those and silently drop them from every non-empty search.
 */
function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement(node)) {
    const { children } = node.props as { children?: React.ReactNode };
    return nodeText(children);
  }
  return "";
}

function ComboboxPopup({
  children,
  className,
  searchPlaceholder = "Search…",
  sideOffset = 4,
  portalProps,
}: ComboboxPopupProps) {
  const [searchValue, setSearchValue] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Filter children on the search value: a case-insensitive substring match
  // against each ComboboxItem's flattened label text. Non-element children
  // (raw strings, separators) are always kept.
  const filteredChildren = React.useMemo(() => {
    if (!searchValue.trim()) return children;

    const query = searchValue.toLowerCase();
    return React.Children.toArray(children).filter((child) => {
      if (!React.isValidElement(child)) return true;
      // child.props is typed as unknown by React 19 — narrow it safely.
      const childProps = child.props as { children?: React.ReactNode };
      return nodeText(childProps.children).toLowerCase().includes(query);
    });
  }, [children, searchValue]);

  return (
    <ComboboxPrimitive.Portal {...portalProps}>
      <ComboboxPrimitive.Positioner sideOffset={sideOffset} className="z-50">
        <ComboboxPrimitive.Popup
          className={cn(
            "relative z-50 w-[var(--anchor-width)] min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md",
            "origin-[var(--transform-origin)] transition-[opacity,transform,translate,scale] duration-[var(--motion-overlay)] ease-[var(--ease-entry)]",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:-translate-y-1",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:-translate-y-1",
            className,
          )}
        >
          {/* Search input pinned at the top */}
          <div className="flex items-center border-b px-2 py-1.5 gap-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <ComboboxPrimitive.Input
              ref={inputRef}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 min-w-0"
              placeholder={searchPlaceholder}
              value={searchValue}
              onChange={(e) => setSearchValue(e.currentTarget.value)}
            />
          </div>

          {/* Scrollable option list — capped at ~280px before scrolling */}
          <ComboboxPrimitive.List className="max-h-[280px] overflow-y-auto overflow-x-hidden p-1">
            {filteredChildren}
            <ComboboxPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground">
              No results found.
            </ComboboxPrimitive.Empty>
          </ComboboxPrimitive.List>
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}
ComboboxPopup.displayName = "ComboboxPopup";

// ── Item ──────────────────────────────────────────────────────────────────────

const ComboboxItem = React.forwardRef<
  React.ComponentRef<typeof ComboboxPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ComboboxPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <ComboboxPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none",
      // Highlighted option uses the PRIMARY button colours (per design), not the
      // subtle neutral accent the menus use.
      "data-[highlighted]:bg-primary data-[highlighted]:text-primary-foreground",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <ComboboxPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </ComboboxPrimitive.ItemIndicator>
    </span>
    {/* ItemText does not exist on Base UI Combobox — children is the label */}
    {children}
  </ComboboxPrimitive.Item>
));
ComboboxItem.displayName = "ComboboxItem";

export {
  Combobox,
  ComboboxTrigger,
  ComboboxValue,
  ComboboxPopup,
  ComboboxItem,
};
