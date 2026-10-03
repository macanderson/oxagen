// The pieces the Assignments, Gates, Proposals and Compiler bodies share
// (roadmap pages/steering-assignments.md, steering-gates.md,
// steering-proposals.md, steering-compiler.md): the mockup's `.note` (a gold
// rule and muted text), a panel with a heading, a badge and actions in its
// header, and the "not recorded" value a cell prints where no read backs it.
//
// A not-recorded value carries the issue that tracks its backend in its
// tooltip and as `data-issue`, so a reader can follow it and a test can hold
// it; it never draws a figure, because a placeholder number would read as a
// record.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { panel, panelHeader, panelTitle } from "@/ui/control-styles";

/** `.note { border-left:2px solid var(--gold); font-size:12.5px; color:var(--muted) }` */
const note =
  "border-l-2 border-gold py-0.5 pl-3 text-[12.5px] text-muted-foreground";

export function Note({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <p className={note} data-testid={testId}>
      {children}
    </p>
  );
}

/** `code` inside a translated sentence. */
export const code = (chunks: ReactNode) => (
  <code className="font-mono text-[0.92em]">{chunks}</code>
);

/**
 * A `.panel` with its `.panel-h`: a heading named by `id`, a badge and any
 * header actions on the right, then the body. The heading is an h3 because
 * the hub's tab panel sits under the page's h1 and the state frames' h2.
 */
export function TabPanel({
  id,
  title,
  badge,
  actions,
  children,
  testId,
}: {
  id: string;
  title: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section aria-labelledby={id} className={panel} data-testid={testId}>
      <div className={panelHeader}>
        <h3 id={id} className={panelTitle}>
          {title}
        </h3>
        {badge === undefined && actions === undefined ? null : (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {badge}
            {actions}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

/** A value no read backs yet: "not recorded", with the issue in its tooltip. */
export function Unrecorded({ issue }: { issue: number }) {
  const t = useTranslations("steering.bodies");
  return (
    <span
      data-unrecorded=""
      data-issue={String(issue)}
      title={t("issue", { number: String(issue) })}
      className="font-sans text-[12.5px] text-muted-foreground"
    >
      {t("notRecorded")}
    </span>
  );
}
