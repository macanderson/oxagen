// What the Run page says about a run a backfill rebuilt (ADR-161, #4028).
//
// `oxagen agent backfill` rebuilds a session from the harness's transcript
// after the session ended. Nothing gated it, so the header marks it, and the
// tier, the policy decisions and the seal say "not recorded" or "at
// backfill" where a live run shows what Oxagen enforced. Its cost is the
// rollup's estimate from the price book, and the page labels it so.
//
// A backfilled run that a live session later continued reads `mixed`. The
// part Oxagen recorded live was governed, so that run keeps its panels and
// only the header says part of it was rebuilt.
import { useTranslations } from "next-intl";
import type { RunRow } from "@/data/contracts/runs";
import { Badge } from "@/ui/badge";
import { useFormatter } from "@/ui/formatter";

type Basis = Pick<RunRow, "recordBasis">;

/** A run a backfill rebuilt that no live session continued. */
export function isBackfilled(run: Basis): boolean {
  return run.recordBasis === "backfill";
}

/** The header's badge for a rebuilt run; nothing for any other. */
export function BackfillBadge({ run }: { run: Basis }) {
  const t = useTranslations("run.backfill");
  if (run.recordBasis === "backfill")
    return (
      <Badge tone="quiet" dot={false} data-testid="run-backfilled">
        {t("badge")}
      </Badge>
    );
  if (run.recordBasis === "mixed")
    return (
      <Badge tone="quiet" dot={false} data-testid="run-backfilled">
        {t("partlyBadge")}
      </Badge>
    );
  return null;
}

/** The one line under the header's chips that says how the run was rebuilt. */
export function BackfillNote({
  run,
}: {
  run: Pick<RunRow, "recordBasis" | "sealedAt" | "sealSource">;
}) {
  const t = useTranslations("run.backfill");
  const format = useFormatter();
  if (run.recordBasis !== "backfill" && run.recordBasis !== "mixed")
    return null;
  // The pass seals the session's `agent_stop`, and the control plane stamps
  // the seal when it receives it, so a seal from the host's own stop dates
  // the backfill. An idle close or an operator's seal is a later instant, and
  // an open run has none, so the line then names no date.
  const at =
    run.recordBasis === "backfill" && run.sealSource === "agent_stop"
      ? run.sealedAt
      : null;
  return (
    <p
      data-testid="run-backfill-note"
      className="mt-2 max-w-[70ch] text-sm text-muted-foreground"
    >
      {run.recordBasis === "mixed"
        ? t("partlyNote")
        : at === null
          ? t("undatedNote")
          : t("note", {
              date: format.dateTime(new Date(at), { dateStyle: "medium" }),
            })}
    </p>
  );
}

/** The Cost tab's line over a rebuilt run's figures. */
export function BackfillCostNote() {
  const t = useTranslations("run.backfill");
  return (
    <p
      data-testid="cost-backfill"
      className="max-w-prose text-sm text-muted-foreground"
    >
      {t("costNote")}
    </p>
  );
}
