// The pieces the Run page's sections share: the mockup's panel, a key/value
// list, the one-sentence note, a meter, and the "not recorded" span every
// section prints for a value the store did not carry. A section never
// substitutes a zero, a default or a neighbouring column for a value the run
// does not have (§3.4).
//
// Each piece draws one rule of the design of record (`mockups/src/engine.css`
// in the roadmap repository, ADR-132), named in the comment above it.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  kvList,
  kvTerm,
  kvValue,
  mono,
  note,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";

export function NoValue() {
  const t = useTranslations("run");
  return <span className="text-muted-foreground">{t("notRecorded")}</span>;
}

function panelId(title: string) {
  return `run-panel-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
}

/**
 * `.panel` with its `.panel-h` (`h3` at 13.5px, the aside pushed right by
 * `.sp { margin-left:auto }`) and one `.panel-b`. A panel whose body is a
 * table or several bodies passes `flush` and draws its own `PanelBody`s.
 */
export function Panel({
  title,
  aside,
  children,
  flush = false,
  testId,
}: {
  title: string;
  /** A count, a basis or a badge, set against the title. */
  aside?: ReactNode;
  children: ReactNode;
  /** The children are the panel's bodies (a table, several `PanelBody`s). */
  flush?: boolean;
  testId?: string;
}) {
  const id = panelId(title);
  return (
    <section aria-labelledby={id} data-testid={testId} className={panel}>
      <div className={panelHeader}>
        <h3 id={id} className={panelTitle}>
          {title}
        </h3>
        {aside === undefined ? null : (
          <div className="ml-auto flex min-w-0 flex-wrap items-center gap-[7px]">
            {aside}
          </div>
        )}
      </div>
      {flush ? children : <div className={panelBody}>{children}</div>}
    </section>
  );
}

/** `.panel-b`, with the hairline above it when it follows another body. */
export function PanelBody({
  children,
  rule = false,
}: {
  children: ReactNode;
  rule?: boolean;
}) {
  return (
    <div className={`${panelBody} ${rule ? "border-t border-border" : ""}`}>
      {children}
    </div>
  );
}

/** `.note`: how to read what sits above it, in one or two sentences. */
export function Note({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <p data-testid={testId} className={`${note} m-0`}>
      {children}
    </p>
  );
}

/** `.kv`: a record's fields, the label in the dim ink and the value right. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className={kvList}>{children}</dl>;
}

export function Fact({
  label,
  children,
  /** A digest, an id or a path reads as code, never as prose. */
  code = false,
}: {
  label: string;
  children: ReactNode;
  code?: boolean;
}) {
  return (
    <>
      <dt className={kvTerm}>{label}</dt>
      <dd className={code ? `${kvValue} ${mono} break-all` : kvValue}>
        {children}
      </dd>
    </>
  );
}

/**
 * `.meter .lab` (the label left, the figure bold right) over `.meter .bar`
 * (a 6px track on the wash with its fill). `share` is 0 to 1 of the widest
 * meter in the set; null draws the track empty, never a guessed width.
 */
export function Meter({
  label,
  value,
  share,
  hue = "bg-info",
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  share: number | null;
  /** The fill's token class; a state hue or a frame-kind hue, never the gold. */
  hue?: string;
  title?: string;
}) {
  const width =
    share === null ? 0 : Math.max(1, Math.round(Math.min(1, share) * 100));
  return (
    <div className="grid gap-[5px]" title={title}>
      <div className="flex justify-between gap-2.5 text-xs text-muted-foreground">
        <span className="min-w-0">{label}</span>
        <b className="font-semibold tabular-nums text-foreground">{value}</b>
      </div>
      <div className="h-1.5 overflow-hidden rounded-[3px] bg-hl">
        <i
          aria-hidden="true"
          className={`block h-full rounded-[3px] ${hue}`}
          style={{ width: `${String(width)}%` }}
        />
      </div>
    </div>
  );
}
