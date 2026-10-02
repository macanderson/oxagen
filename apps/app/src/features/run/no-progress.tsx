// No-progress limit (spend spec, detector 1; #4490): one line per loop that
// reached the workspace's no-progress limit, read from `get_run_cost`. A loop
// is one call made again and again in a row with an unchanged result. Each
// line names the call, how often it ran, the limit and the call that reached
// it, the mode, and what became of the run: recorded and went on (observe),
// paused at the next checkpoint (enforced), or not paused, with the reason
// the check recorded.
//
// A run with no loop at the limit draws nothing.
import { useTranslations } from "next-intl";
import type { RunNoProgressHit } from "@/data/contracts/run";
import { Badge } from "@/ui/badge";
import { Note, Panel } from "./parts";

/** What became of the run, in the words the line ends on. */
function Outcome({ hit }: { hit: RunNoProgressHit }) {
  const t = useTranslations("run.cost.noProgress");
  if (hit.mode === "observe") return <>{t("outcome.observe")}</>;
  if (hit.outcome === "paused") return <>{t("outcome.paused")}</>;
  return hit.pauseBlock === null ? (
    <>{t("outcome.blockedUnrecorded")}</>
  ) : (
    <>{t("outcome.blocked", { reason: t(`block.${hit.pauseBlock}`) })}</>
  );
}

function HitLine({ hit }: { hit: RunNoProgressHit }) {
  const t = useTranslations("run.cost.noProgress");
  return (
    <li
      data-testid="no-progress-hit"
      data-mode={hit.mode}
      data-outcome={hit.outcome}
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]"
    >
      <Badge
        tone={hit.outcome === "paused" ? "denied" : "quiet"}
        dot={false}
        mono
      >
        {t(`mode.${hit.mode}`)}
      </Badge>
      <span className="min-w-0 break-words">
        {t("line", {
          tool: hit.tool,
          repeats: hit.repeats,
          limit: hit.limit,
          atCall: hit.atCall,
        })}{" "}
        <Outcome hit={hit} />
      </span>
    </li>
  );
}

export function NoProgressHits({
  hits,
}: {
  hits: readonly RunNoProgressHit[];
}) {
  const t = useTranslations("run.cost.noProgress");
  if (hits.length === 0) return null;
  return (
    <Panel title={t("title")} testId="no-progress">
      <div className="flex flex-col gap-2.5">
        <Note>{t("note")}</Note>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {hits.map((hit) => (
            <HitLine
              key={[hit.tool, hit.loop, hit.atCall].join(":")}
              hit={hit}
            />
          ))}
        </ul>
      </div>
    </Panel>
  );
}
