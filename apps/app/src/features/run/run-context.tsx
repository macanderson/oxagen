import { useTranslations } from "next-intl";
import type { RunRow } from "@/data/contracts/runs";
import { mono } from "@/ui/control-styles";

/** Recorded local identity; a missing value never borrows the agent's name. */
export function RunContext({ run }: { run: RunRow }) {
  const t = useTranslations("run.context");
  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">{t("harness")}</dt>
      <dd>{run.harness ?? t("notRecorded")}</dd>
      <dt className="text-muted-foreground">{t("repository")}</dt>
      <dd className="break-all">
        {run.repository?.name ?? run.repository?.root ?? t("notRecorded")}
      </dd>
      <dt className="text-muted-foreground">{t("directory")}</dt>
      <dd className={`${mono} break-all`}>
        {run.workingDirectory ?? t("notRecorded")}
      </dd>
      <dt className="text-muted-foreground">{t("branch")}</dt>
      <dd className={`${mono} break-all`}>
        {run.repository?.branch ?? t("notRecorded")}
      </dd>
      <dt className="text-muted-foreground">{t("commit")}</dt>
      <dd className={`${mono} break-all`}>
        {run.repository?.commit ?? t("notRecorded")}
      </dd>
    </dl>
  );
}
