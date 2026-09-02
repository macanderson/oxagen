import * as React from "react";
import { cn } from "../lib/utils";

/*
 * coss ui Table — the shared data-table primitive set.
 *
 * The shared `<table>` markup for every data surface (billing usage,
 * registries, evals, skills, environments…). Token-driven: the header is FLAT —
 * it takes the card-header tokens, which match the card surface exactly, so the
 * header reads as a hairline-separated band rather than a shaded bar (THEME.md
 * — "card and table headers are flat"). Rows use the border/muted tokens, and
 * density is a single CSS-var knob so every cell follows.
 *
 *   <Table density="compact">
 *     <TableHeader>
 *       <TableRow><TableHead>Name</TableHead><TableHead className="text-right">Cost</TableHead></TableRow>
 *     </TableHeader>
 *     <TableBody>
 *       <TableRow interactive onClick={...}>
 *         <TableCell>…</TableCell>
 *       </TableRow>
 *       <TableEmpty colSpan={2}>No usage yet</TableEmpty>
 *     </TableBody>
 *   </Table>
 *
 * The table always renders inside an `overflow-x-auto` container so wide
 * tables scroll horizontally on small screens instead of breaking the page.
 * Pair with `<Panel inset>` for a flush, titled surface.
 */

type TableDensity = "default" | "compact";

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /** Row padding scale. `compact` tightens vertical rhythm for dense data. */
  density?: TableDensity;
  /** Class applied to the scroll container wrapping the `<table>`. */
  containerClassName?: string;
}

const densityVars: Record<TableDensity, string> = {
  // One knob per axis — every cell and header reads these vars.
  default: "[--table-pad-x:0.75rem] [--table-pad-y:0.625rem]",
  compact: "[--table-pad-x:0.625rem] [--table-pad-y:0.375rem]",
};

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, density = "default", containerClassName, ...props }, ref) => (
    <div className={cn("relative w-full overflow-x-auto", containerClassName)}>
      <table
        ref={ref}
        className={cn(
          "w-full caption-bottom text-sm",
          densityVars[density],
          className,
        )}
        {...props}
      />
    </div>
  ),
);
Table.displayName = "Table";

export interface TableHeaderProps
  extends React.HTMLAttributes<HTMLTableSectionElement> {
  /** Keep the header visible while the table body scrolls under it. */
  sticky?: boolean;
}

const TableHeader = React.forwardRef<HTMLTableSectionElement, TableHeaderProps>(
  ({ className, sticky, ...props }, ref) => (
    <thead
      ref={ref}
      className={cn(
        "bg-card-header-bg [&_tr]:border-b [&_tr]:border-border [&_tr]:hover:bg-transparent",
        sticky && "sticky top-0 z-10",
        className,
      )}
      {...props}
    />
  ),
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      "border-t border-border bg-muted/40 font-medium [&>tr]:last:border-b-0",
      className,
    )}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

export interface TableRowProps
  extends React.HTMLAttributes<HTMLTableRowElement> {
  /** Pointer affordance for clickable rows (row-level navigation/selection). */
  interactive?: boolean;
}

const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, interactive, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        "border-b border-border/50 transition-colors duration-[var(--motion-micro)] hover:bg-muted/50 data-[state=selected]:bg-muted",
        interactive && "cursor-pointer",
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-9 whitespace-nowrap px-[var(--table-pad-x)] text-left align-middle text-xs font-medium uppercase tracking-wide text-card-header-fg/70",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "px-[var(--table-pad-x)] py-[var(--table-pad-y)] align-middle",
      className,
    )}
    {...props}
  />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("mt-3 text-xs text-muted-foreground", className)}
    {...props}
  />
));
TableCaption.displayName = "TableCaption";

export interface TableEmptyProps
  extends React.HTMLAttributes<HTMLTableRowElement> {
  /** Number of columns the empty message spans (match your header). */
  colSpan: number;
}

/** Full-width empty-state row — render inside `<TableBody>` when there are no rows. */
const TableEmpty = React.forwardRef<HTMLTableRowElement, TableEmptyProps>(
  ({ className, colSpan, children, ...props }, ref) => (
    <tr ref={ref} className={cn("hover:bg-transparent", className)} {...props}>
      <td
        colSpan={colSpan}
        className="px-[var(--table-pad-x)] py-8 text-center text-sm text-muted-foreground"
      >
        {children ?? "No results."}
      </td>
    </tr>
  ),
);
TableEmpty.displayName = "TableEmpty";

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
  TableEmpty,
};
