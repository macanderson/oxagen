import { useTranslations } from "next-intl";
import type { RunRow } from "@/data/contracts/runs";
import { routes } from "@/shared/safe-path";
import { GeneratedSummary } from "@/ui/generated-summary";
import { linkText, panel } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";

export function RunSummary({
  run,
  org,
  ws,
}: {
  run: RunRow;
  org: string;
  ws: string;
}) {
  const t = useTranslations("run");
  return (
    <section
      aria-labelledby="run-summary"
      className={`${panel} flex flex-col gap-3 p-5`}
    >
      <h2 id="run-summary" className="text-base font-semibold">
        {t("summaryTitle")}
      </h2>
      {run.summary === null ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("noSummary")}
        </p>
      ) : (
        <GeneratedSummary summary={run.summary} layout="block" />
      )}
      <SafeLink
        className={`${linkText} min-h-11 self-start py-3 text-sm`}
        to={routes.run(org, ws, run.id, { tab: "frames" })}
      >
        {t("summaryFrames")}
      </SafeLink>
    </section>
  );
}
