// What happened to one Context PR, oldest first (#5077): raised, the pull
// request opened, the checks, and the merge or the close, each marked as made
// in Oxagen or on the repository host. It is built from what the proposal
// records. Oxagen stores no time for the pull request opening, so that step
// says so rather than borrowing another step's time.
import { useTranslations } from "next-intl";
import type { ContextPr } from "@/data/contracts/steering";
import { Section, useDate } from "./section";

type Step = {
  key: string;
  /** RFC 3339, or null when nothing recorded when it happened. */
  at: string | null;
  text: string;
  /** Who made the step happen, as the page names them; null when nobody is recorded. */
  by: string | null;
  origin: "oxagen" | "host";
};

/** The earliest and latest instants among the checks, or null when none ran. */
function checkSpan(checks: ContextPr["checks"]): {
  started: string | null;
  completed: string | null;
} {
  const started = checks
    .map((check) => check.startedAt)
    .filter((at): at is string => at !== null)
    .sort();
  const completed = checks
    .map((check) => check.completedAt)
    .filter((at): at is string => at !== null)
    .sort();
  return { started: started[0] ?? null, completed: completed.at(-1) ?? null };
}

export function ContextPrActivity({ pr }: { pr: ContextPr }) {
  const t = useTranslations("steering.pr.activity");
  const date = useDate();
  const host = pr.pr?.provider === "gitlab" ? t("gitlab") : t("github");
  const steps: Step[] = [
    {
      key: "raised",
      at: pr.raised.at,
      text: t("raised"),
      by: pr.raised.sourceName ?? pr.raised.source,
      origin: "oxagen",
    },
  ];
  if (pr.pr !== null) {
    steps.push({
      key: "opened",
      at: null,
      text: t("opened", { number: String(pr.pr.number) }),
      by: null,
      origin: "oxagen",
    });
  }
  const span = checkSpan(pr.checks);
  if (span.started !== null) {
    steps.push({
      key: "checks-started",
      at: span.started,
      text: t("checksStarted"),
      by: null,
      origin: "oxagen",
    });
  }
  const finished =
    pr.checks.length > 0 &&
    pr.checks.every((check) => check.status === "passed" || check.status === "failed");
  if (finished && span.completed !== null) {
    steps.push({
      key: "checks-finished",
      at: span.completed,
      text: pr.checks.some((check) => check.status === "failed")
        ? t("checksFailed")
        : t("checksPassed"),
      by: null,
      origin: "oxagen",
    });
  }
  if (pr.merged !== null) {
    steps.push({
      key: "merged",
      at: pr.merged.at,
      text: t("merged"),
      by: pr.merged.byName,
      origin: pr.merged.onHost ? "host" : "oxagen",
    });
  }
  if (pr.closed !== null) {
    steps.push({
      key: "closed",
      at: pr.closed.at,
      text:
        pr.closed.reason === null
          ? t("closed")
          : t("closedBecause", { reason: pr.closed.reason }),
      by: pr.closed.byName,
      origin: pr.closed.onHost ? "host" : "oxagen",
    });
  }
  return (
    <Section id="context-pr-activity" title={t("title")}>
      <ol className="flex flex-col divide-y divide-border text-sm">
        {steps.map((step) => (
          <li
            key={step.key}
            data-step={step.key}
            data-origin={step.origin}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-foreground">{step.text}</span>
              <span className="text-xs text-muted-foreground">
                {step.origin === "host"
                  ? t("onHost", { host })
                  : t("inOxagen")}
                {step.by === null ? null : ` ${t("by", { who: step.by })}`}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {step.at === null ? t("timeNotRecorded") : date(step.at)}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
