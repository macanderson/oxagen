"use client";
// shadcn's base-maia pagination (ADR-221), written from
// https://ui.shadcn.com/r/styles/base-maia/pagination.json, and the pager
// every list draws under its rows, laid out as shadcn's "icons only" example:
// a Rows per page select on the left, Previous and Next on the right.
//
// Two changes from the registry: every label arrives translated from the
// caller (INV-12), and a step is a button unless the list pages by address.
// A list that pages in the browser passes a function, and a missing step is
// a disabled button, because a link cannot be disabled. A list that pages by
// address, such as the audit record, passes the path, and the step is a link.
// The fleet's pager keeps its own numbered links, and draws `RowsField` on
// its left.
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { type ComponentProps, type ReactNode, useId } from "react";
import type { SafePath } from "@/shared/safe-path";
import { Button } from "@/ui/button";
import { cn } from "@/ui/cn";
import { SafeLink } from "@/ui/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

function Pagination({ className, ...props }: ComponentProps<"nav">) {
  return (
    <nav
      data-slot="pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      {...props}
    />
  );
}

function PaginationContent({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn("flex items-center gap-1", className)}
      {...props}
    />
  );
}

function PaginationItem(props: ComponentProps<"li">) {
  return <li data-slot="pagination-item" {...props} />;
}

type StepProps = Omit<ComponentProps<typeof Button>, "children"> & {
  /** The word beside the caret, and the name when the word is hidden. */
  text: string;
};

function PaginationPrevious({ className, text, ...props }: StepProps) {
  return (
    <Button
      variant="ghost"
      aria-label={text}
      className={cn("pl-2!", className)}
      {...props}
    >
      <CaretLeftIcon data-icon="inline-start" className="rtl:-scale-x-100" />
      <span className="hidden sm:block">{text}</span>
    </Button>
  );
}

function PaginationNext({ className, text, ...props }: StepProps) {
  return (
    <Button
      variant="ghost"
      aria-label={text}
      className={cn("pr-2!", className)}
      {...props}
    >
      <span className="hidden sm:block">{text}</span>
      <CaretRightIcon data-icon="inline-end" className="rtl:-scale-x-100" />
    </Button>
  );
}

/**
 * A press that turns the page, the address of the next page that way, or null
 * when there is no page that way.
 */
type PagerStep = (() => void) | SafePath | null;

function stepProps(step: PagerStep) {
  if (step === null) return { disabled: true };
  if (typeof step === "string")
    return { nativeButton: false, render: <SafeLink to={step} /> };
  return { onClick: step };
}

/**
 * Rows per page, the field on the left of every pager, as a horizontal
 * field: the label, then a select of the sizes.
 */
export function RowsField({
  label,
  perPage,
  sizes,
  onPerPage,
  sizeLabel = String,
  testId,
}: {
  /** "Rows per page". */
  label: string;
  perPage: number;
  sizes: readonly number[];
  onPerPage: (size: number) => void;
  /** How a size reads in the select, when a size such as 0 means "All". */
  sizeLabel?: (size: number) => string;
  /** A `data-testid` for the select's trigger. */
  testId?: string;
}) {
  const id = useId();
  const items = sizes.map((size) => ({ value: size, label: sizeLabel(size) }));
  return (
    <div
      role="group"
      aria-labelledby={id}
      data-slot="field"
      data-orientation="horizontal"
      className="flex w-fit flex-row items-center gap-3"
    >
      <span
        id={id}
        data-slot="field-label"
        className="flex w-fit gap-2 text-sm leading-snug whitespace-nowrap text-muted-foreground max-sm:sr-only"
      >
        {label}
      </span>
      <Select
        items={items}
        value={perPage}
        onValueChange={(value) => {
          if (value !== null) onPerPage(value);
        }}
      >
        <SelectTrigger
          aria-labelledby={id}
          data-testid={testId}
          className="w-20 max-md:min-h-11"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The pager under a list: Rows per page on the left, beside the range the
 * page shows ("1–10 of 75"), and Previous and Next on the right.
 */
export function RowsPager({
  label,
  rowsLabel,
  perPage,
  sizes,
  onPerPage,
  sizeLabel,
  range,
  beside,
  previousLabel,
  nextLabel,
  previous,
  next,
  className,
}: {
  /** The pager's name as a landmark: "Pages". */
  label: string;
  /** "Rows per page". */
  rowsLabel: string;
  perPage: number;
  sizes: readonly number[];
  onPerPage: (size: number) => void;
  /** How a size reads in the select, when a size such as 0 means "All". */
  sizeLabel?: (size: number) => string;
  range?: ReactNode;
  /** Drawn after the range, such as a link to rows the list leaves out. */
  beside?: ReactNode;
  previousLabel: string;
  nextLabel: string;
  previous: PagerStep;
  next: PagerStep;
  className?: string;
}) {
  return (
    <div
      data-rows-pager=""
      className={cn(
        "flex items-center justify-between gap-4 px-3 py-2.5",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <RowsField
          label={rowsLabel}
          perPage={perPage}
          sizes={sizes}
          onPerPage={onPerPage}
          sizeLabel={sizeLabel}
        />
        {range === undefined ? null : (
          <span
            data-range=""
            className="font-mono text-xs whitespace-nowrap text-dim tabular-nums"
          >
            {range}
          </span>
        )}
        {beside}
      </div>
      <Pagination aria-label={label} className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              text={previousLabel}
              className="max-md:min-h-11"
              {...stepProps(previous)}
            />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext
              text={nextLabel}
              className="max-md:min-h-11"
              {...stepProps(next)}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
