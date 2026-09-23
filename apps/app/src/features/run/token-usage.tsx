import { useLocale, useTranslations } from "next-intl";
import type { TranscriptEntry, TranscriptUsage } from "@/data/contracts/run";
import { formatCount } from "@/ui/money-format";

const CLASSES = [
  "inputUncached",
  "cacheRead",
  "cacheWrite",
  "output",
  "reasoning",
] as const;

export function reportedTokens(
  entries: readonly TranscriptEntry[],
): TranscriptUsage | null {
  const values = entries.flatMap((entry) => (entry.usage ? [entry.usage] : []));
  if (values.length === 0) return null;
  const sum = (key: keyof TranscriptUsage) => {
    const counts = values.flatMap((value) =>
      value[key] === null ? [] : [value[key]],
    );
    return counts.length === 0 ? null : counts.reduce((a, b) => a + b, 0);
  };
  return {
    inputUncached: sum("inputUncached"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    output: sum("output"),
    reasoning: sum("reasoning"),
  };
}

export function TokenUsage({
  entries,
}: {
  entries: readonly TranscriptEntry[];
}) {
  const t = useTranslations("run.tokenUsage");
  const locale = useLocale();
  const usage = reportedTokens(entries);
  return (
    <div
      data-testid="reported-token-usage"
      className="flex flex-col gap-2 border-b border-border px-3 py-3 text-xs"
    >
      <p className="font-medium">{t("title")}</p>
      {usage === null ? (
        <p className="text-muted-foreground">{t("missing")}</p>
      ) : (
        <dl className="flex flex-wrap gap-x-5 gap-y-2">
          {CLASSES.map((key) => (
            <div key={key}>
              <dt className="text-muted-foreground">{t(key)}</dt>
              <dd className="font-mono tabular-nums">
                {usage[key] === null
                  ? t("notRecorded")
                  : formatCount(usage[key], locale)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-muted-foreground">{t("coverage")}</p>
    </div>
  );
}
