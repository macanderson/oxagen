// A slice of the Spend design no store records yet (the spec's ❌ and 🟡
// rows). It says what is missing in the product's words and carries the
// backend issue that would record it as a data attribute, so the gap is
// visible to a reader and traceable to a maintainer, and nothing on the page
// prints an invented figure or a zero in its place (INV-10). A figure-sized
// gap inside a table or a tile uses <NotRecordedValue> instead.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { panel, panelHeader, panelTitle } from "@/ui/control-styles";

/**
 * The backend issues on macanderson/oxagen that record each missing slice:
 * #2962 the cost rollup (prompt parts, harness, observed share, per-class
 * cost, provider key, coaching, waste causes, per-key export), #2963 the
 * findings job (who a finding is about, its trend, findings per key), #3864
 * spend ceilings for an agent or an operator, #3846 asking for access, #3847
 * opening an incident, #3841 a failed read's trace and deciding policy.
 */
export const GAP_ISSUE = {
  rollup: 2962,
  findings: 2963,
  budgets: 3864,
  access: 3846,
  incident: 3847,
  trace: 3841,
} as const;
export type GapIssue = keyof typeof GAP_ISSUE;

export function NotBacked({
  gap,
  children,
}: {
  gap: GapIssue;
  /** What is missing, translated: one or two sentences. */
  children: ReactNode;
}) {
  const t = useTranslations("spend");
  return (
    <p
      data-testid="spend-not-backed"
      data-issue={GAP_ISSUE[gap]}
      className="max-w-prose text-[12.5px] leading-relaxed text-muted-foreground"
    >
      <span className="font-medium text-foreground">{t("notBacked.lead")}</span>{" "}
      {children}
    </p>
  );
}

/** A panel whose whole body is not recorded yet: its heading, then the gap. */
export function NotBackedPanel({
  id,
  title,
  gap,
  children,
}: {
  id: string;
  title: string;
  gap: GapIssue;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={panel}>
      <div className={panelHeader}>
        <h2 id={id} className={panelTitle}>
          {title}
        </h2>
      </div>
      <div className="px-4 py-3.5">
        <NotBacked gap={gap}>{children}</NotBacked>
      </div>
    </section>
  );
}
