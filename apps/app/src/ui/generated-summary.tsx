// What `summarize_run` wrote, labelled generated wherever it renders (ADR-058):
// a light-tier model's account of what a run changed. The label is not
// decoration. The record is the frames, and a reader must be able to tell the
// model's sentence from the recording at a glance. The model that wrote it and
// the instant it was written are on the same element, so the label can never
// travel without its provenance.
import { useTranslations } from "next-intl";
import type { RunSummary } from "@/data/contracts/runs";
import { useFormatter } from "@/ui/formatter";

function GeneratedLabel() {
  const t = useTranslations("ui.generated");
  return (
    <span className="inline-flex items-center rounded-sm bg-muted px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
      {t("label")}
    </span>
  );
}

export function GeneratedSummary({
  summary,
  /** `line` clamps to two lines in a table cell; `block` is the Run header's paragraph. */
  layout = "line",
}: {
  summary: RunSummary;
  layout?: "line" | "block";
}) {
  const t = useTranslations("ui.generated");
  const format = useFormatter();
  const provenance = t("provenance", {
    model: summary.model,
    when: format.dateTime(new Date(summary.generatedAt), {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  });
  return (
    <div
      data-testid="generated-summary"
      className={
        layout === "block"
          ? "flex flex-col gap-1.5"
          : "flex flex-col gap-0.5 text-xs"
      }
    >
      <p
        className={
          layout === "block"
            ? "max-w-prose text-sm text-foreground"
            : "line-clamp-2 text-muted-foreground"
        }
      >
        {summary.text}
      </p>
      <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <GeneratedLabel />
        <span>{provenance}</span>
      </p>
    </div>
  );
}
