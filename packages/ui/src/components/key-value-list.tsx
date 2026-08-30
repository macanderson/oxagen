import * as React from "react";
import { cn } from "../lib/utils";

/*
 * KeyValueList — the shared description-list (`<dl>`) for dense metadata:
 * node properties, run detail, subscription summaries, template config.
 *
 * One consistent grid instead of the per-surface `grid-cols-[minmax(…)_1fr]`
 * variations. Values keep word-break for ids/URLs; pass any ReactNode (badges,
 * CopyButton pairs, links) as a value.
 *
 *   <KeyValueList
 *     items={[
 *       { label: "Status", value: <Badge variant="success-soft" dot>Active</Badge> },
 *       { label: "Region", value: "us-east-1" },
 *     ]}
 *   />
 */
export interface KeyValueItem {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Optional stable key when labels can repeat. */
  key?: string;
}

export interface KeyValueListProps
  extends Omit<React.HTMLAttributes<HTMLDListElement>, "children"> {
  items: KeyValueItem[];
  /** Tighter row rhythm for sidebars and popovers. */
  dense?: boolean;
  /** Stack label above value instead of the two-column grid. */
  stacked?: boolean;
}

const KeyValueList = React.forwardRef<HTMLDListElement, KeyValueListProps>(
  ({ className, items, dense, stacked, ...props }, ref) => (
    <dl
      ref={ref}
      className={cn(
        "grid text-sm",
        stacked
          ? cn("grid-cols-1", dense ? "gap-y-2" : "gap-y-3")
          : cn(
              "grid-cols-[minmax(6rem,auto)_1fr] gap-x-4",
              dense ? "gap-y-1" : "gap-y-1.5",
            ),
        className,
      )}
      {...props}
    >
      {items.map((item, i) =>
        stacked ? (
          // HTML5 permits <div> pair-wrappers inside <dl>; keeps the grid gap
          // between PAIRS rather than between each label and its value.
          <div key={item.key ?? i} className="min-w-0 space-y-0.5">
            <dt className="text-xs font-medium text-muted-foreground">
              {item.label}
            </dt>
            <dd className="min-w-0 break-words font-medium text-foreground">
              {item.value}
            </dd>
          </div>
        ) : (
          <React.Fragment key={item.key ?? i}>
            <dt className="min-w-0 text-muted-foreground">{item.label}</dt>
            <dd className="min-w-0 break-words font-medium text-foreground">
              {item.value}
            </dd>
          </React.Fragment>
        ),
      )}
    </dl>
  ),
);
KeyValueList.displayName = "KeyValueList";

export { KeyValueList };
