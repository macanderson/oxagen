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
import { buttonVariants } from "@/ui/button-variants";
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

/**
 * A press that turns the page, the address of the next page that way, or null
 * when there is no page that way.
 */
type PagerStep = (() => void) | SafePath | null;

type StepProps = {
  /** The word beside the caret, and the name when the word is hidden. */
  text: string;
  step: PagerStep;
  className?: string;
};

/**
 * One step of the pager, drawn as the ghost button. A path draws a link with
 * the button's classes rather than a link rendered through `Button`, because
 * Base UI gives any element its button renders `role="button"`, and a screen
 * reader must hear a link as a link.
 */
function StepControl({
  step,
  text,
  className,
  children,
}: StepProps & { children: ReactNode }) {
  if (typeof step === "string")
    return (
      <SafeLink
        to={step}
        aria-label={text}
        className={cn(buttonVariants({ variant: "ghost" }), className)}
      >
        {children}
      </SafeLink>
    );
  return (
    <Button
      variant="ghost"
      aria-label={text}
      className={className}
      {...(step === null ? { disabled: true } : { onClick: step })}
    >
      {children}
    </Button>
  );
}

function PaginationPrevious({ className, ...props }: StepProps) {
  return (
    <StepControl className={cn("pl-2!", className)} {...props}>
      <CaretLeftIcon data-icon="inline-start" className="rtl:-scale-x-100" />
      <span className="hidden sm:block">{props.text}</span>
    </StepControl>
  );
}

function PaginationNext({ className, ...props }: StepProps) {
  return (
    <StepControl className={cn("pr-2!", className)} {...props}>
      <span className="hidden sm:block">{props.text}</span>
      <CaretRightIcon data-icon="inline-end" className="rtl:-scale-x-100" />
    </StepControl>
  );
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
        className="flex w-fit gap-2 text-base leading-snug whitespace-nowrap text-muted-foreground max-sm:sr-only"
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
            className="font-mono text-sm whitespace-nowrap text-muted-foreground tabular-nums"
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
              step={previous}
            />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext
              text={nextLabel}
              className="max-md:min-h-11"
              step={next}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
