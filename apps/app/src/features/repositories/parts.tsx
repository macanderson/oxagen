// Small pieces every Repositories tab shares: the load state of a record read
// on demand, the mockup's panel frame and note, the danger button, and the
// badge a `.oxagen/` state takes (a dot and a word, so it survives greyscale:
// gold is identity and never encodes state).
import type { ReactNode } from "react";
import {
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import type { RepositoriesFailure } from "./failure";

/** A record being read, refused, or in hand. The refusal is kept as a value so its sentence is formatted at render. */
export type Load<T> =
  | { kind: "loading" }
  | { kind: "failed"; failure: RepositoriesFailure }
  | { kind: "ready"; value: T };

export const prose = "text-[13px] leading-relaxed text-muted-foreground";

/** `.note`: a gold rule on the left and muted prose beside it. */
export const note =
  "border-l-2 border-gold py-0.5 pl-3 text-[12.5px] leading-relaxed text-muted-foreground";

/** `.btn.danger`: the red outline a destructive action takes. */
export const buttonDanger =
  "inline-flex min-h-8 max-md:min-h-11 items-center justify-center gap-1.5 rounded-[9px] border border-error/45 bg-card px-[13px] py-1.5 text-[13px] font-medium text-error-ink transition-colors hover:bg-error/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45";

/** `.btn.sm`: the small secondary a table cell or a panel header carries. */
export const buttonSmall =
  "inline-flex min-h-7 max-md:min-h-11 items-center justify-center whitespace-nowrap rounded-[9px] border border-button-default-border bg-button-default-bg px-2.5 py-1 text-xs font-medium text-button-default-fg hover:bg-button-default-hover-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45";

/** `.kv`: a two-column definition list. */
export const kv =
  "grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] [&>dd]:min-w-0 [&>dd]:break-words [&>dd]:text-foreground [&>dt]:text-muted-foreground";

export const code = (chunks: ReactNode) => (
  <span className={mono}>{chunks}</span>
);

/** A panel with the mockup's flat header: a title, one sentence under it, and an action on the right. */
export function Panel({
  id,
  title,
  subtitle,
  action,
  children,
  testId,
}: {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section aria-labelledby={id} data-testid={testId} className={panel}>
      <div className={`${panelHeader} items-start`}>
        <div className="min-w-0 flex-1">
          <h2 id={id} className={panelTitle}>
            {title}
          </h2>
          {subtitle === undefined ? null : (
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PanelBody({ children }: { children: ReactNode }) {
  return <div className={panelBody}>{children}</div>;
}

/** `wzChecks`: one row per item, the name then what it asserts. */
export function CheckRows({
  rows,
  testId,
}: {
  rows: readonly { key: string; name: ReactNode; what: ReactNode }[];
  testId?: string;
}) {
  return (
    <ul
      data-testid={testId}
      className="overflow-hidden rounded-[10px] border border-border text-[13px]"
    >
      {rows.map((row) => (
        <li
          key={row.key}
          data-row={row.key}
          className="grid gap-x-3 gap-y-0.5 border-b border-border px-3.5 py-2.5 last:border-b-0 sm:grid-cols-[140px_minmax(0,1fr)]"
        >
          <b className="font-semibold text-foreground">{row.name}</b>
          <span className="text-muted-foreground">{row.what}</span>
        </li>
      ))}
    </ul>
  );
}

/** `.sec-lb`: a label over a section of a panel or a dialog. */
export function SectionLabel({
  id,
  children,
}: {
  id?: string;
  children: ReactNode;
}) {
  return (
    <h3
      id={id}
      className="mb-2 text-[12.5px] font-semibold text-muted-foreground"
    >
      {children}
    </h3>
  );
}
