// The not-recorded state for an element with no store behind it (mockup
// `tools.md`, Data sources: "❌ no store, `NotBacked` in production"). It says
// what is missing in one sentence and never stands in a zero, an empty table
// or a fixture: an empty table reads as "no belt exists", which the record
// cannot say either way. The issue that owns the store rides as `data-gap`.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { gapRef, type ToolsGap } from "./gaps";

/** A panel body stating what is not recorded yet, in place of the rows. */
export function NotBacked({
  gap,
  testId,
  children,
}: {
  gap: ToolsGap;
  testId: string;
  /** One sentence: what the record does not hold and why the rows are absent. */
  children: ReactNode;
}) {
  const t = useTranslations("tools");
  return (
    <div
      data-state="not-backed"
      data-gap={gapRef(gap)}
      data-testid={testId}
      className="flex flex-col gap-1 rounded-lg border border-dashed border-border px-3.5 py-3 text-[13px]"
    >
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim">
        {t("notBacked")}
      </span>
      <span className="max-w-prose text-muted-foreground">{children}</span>
    </div>
  );
}

/** A table cell or a fact whose value no store carries yet. */
export function NotBackedValue({ gap }: { gap: ToolsGap }) {
  const t = useTranslations("tools");
  return (
    <span
      data-state="not-backed"
      data-gap={gapRef(gap)}
      className="text-xs text-muted-foreground"
    >
      {t("notCarried")}
    </span>
  );
}
