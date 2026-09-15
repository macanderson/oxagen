// The agent a run belongs to: an avatar, the agent key and the harness label.
// The harness label is the store that recorded the run, the one harness fact
// list_runs carries.
import { useTranslations } from "next-intl";
import type { RunRow } from "@/data/contracts/runs";
import { mono } from "@/ui/control-styles";

export function AgentIdentity({
  agentKey,
  source,
}: Pick<RunRow, "agentKey" | "source">) {
  const t = useTranslations("fleet.runs");
  const slug = agentKey?.split(".").at(-1) ?? "";
  return (
    <span className="flex min-w-0 items-center gap-2">
      {agentKey === null ? null : (
        <span
          aria-hidden="true"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-[30%] border border-border bg-muted text-[11px] font-semibold uppercase"
        >
          {slug.slice(0, 2)}
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        {agentKey === null ? (
          <span className="text-muted-foreground">{t("notRecorded")}</span>
        ) : (
          <span className={`${mono} break-all`}>{agentKey}</span>
        )}
        <span className="text-xs text-muted-foreground">
          {t(`source.${source}`)}
        </span>
      </span>
    </span>
  );
}
