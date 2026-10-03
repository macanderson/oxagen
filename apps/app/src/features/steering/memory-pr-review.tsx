// A memory PR's records (#4518), as list_memory_pr_records reads them
// (#4914). A steering PR on a `memory/` branch proposes one record file per
// lesson drawn from the agents' memories, and the records Promote adds from
// the Memories tab join it. Each card shows the record, the memories it cites
// with the agent each came from, and the runs its evidence names. A record
// the PR proposes has a Drop button that removes it from the branch
// (drop_memory_record). A record the PR archives has none. The cards are
// keyed by path, so a dropped card keeps its state through the page's refresh.
import { useTranslations } from "next-intl";
import type { MemoryPrRecords } from "@/data/contracts/steering";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import type { SteeringAt } from "./view";
import { DropMemoryRecord } from "./write-controls";

/**
 * One record a memory PR proposes or archives.
 *
 * @internal Exported for memory-pr-review.builders.ts.
 */
export type MemoryPrRecord = MemoryPrRecords["records"][number];

/** One memory a record cites: what it says, the agent it came from, and where it was seen. */
type MemoryPrMemory = MemoryPrRecord["memories"][number];

/** A run's public id: `arun_…` for a ledger run, `tse_…` for a wrapped one. */
const RUN = /^(?:arun|tse)_[0-9A-Za-z]+$/;
/** A frame reference, `frame:<run>/<seq>`. */
const FRAME = /^frame:((?:arun|tse)_[0-9A-Za-z]+)\/\d+$/;

/** The runs a memory names, each once and in order, and the evidence that names no run. */
function evidenceOf(memory: MemoryPrMemory): {
  runs: string[];
  other: string[];
} {
  const runs: string[] = [];
  const other: string[] = [];
  const refs =
    memory.run === null ? memory.evidence : [memory.run, ...memory.evidence];
  for (const ref of refs) {
    const run = RUN.test(ref) ? ref : FRAME.exec(ref)?.[1];
    if (run === undefined) {
      if (!other.includes(ref)) other.push(ref);
    } else if (!runs.includes(run)) {
      runs.push(run);
    }
  }
  return { runs, other };
}

function Memory({ at, memory }: { at: SteeringAt; memory: MemoryPrMemory }) {
  const t = useTranslations("steering.pr.memory");
  const { runs, other } = evidenceOf(memory);
  return (
    <li data-memory="" className="flex flex-col gap-0.5 text-base">
      <span className="text-foreground">{memory.statement}</span>
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <span data-agent="">{memory.agent ?? t("unknownAgent")}</span>
        {runs.length === 0 && other.length === 0 ? null : (
          <>
            <span>{t("evidence")}</span>
            {runs.map((run) => (
              <SafeLink
                key={run}
                to={routes.run(at.org, at.ws, run)}
                className={`${linkText} ${mono}`}
              >
                {run}
              </SafeLink>
            ))}
            {other.map((ref) => (
              <span key={ref} className={mono}>
                {ref}
              </span>
            ))}
          </>
        )}
      </span>
    </li>
  );
}

export function MemoryPrReview({
  at,
  number,
  records,
}: {
  at: SteeringAt;
  /** The memory PR's number, which drop_memory_record names it by. */
  number: number;
  records: readonly MemoryPrRecord[];
}) {
  const t = useTranslations("steering.pr.memory");
  return (
    <div className="flex flex-col gap-3">
      {records.map((record) => (
        <article
          key={record.path}
          data-memory-record={record.path}
          className="flex flex-col gap-2 rounded-md border border-border p-3"
        >
          <h4 className="text-base font-semibold text-foreground">
            {record.title}
          </h4>
          <p className={`${mono} text-sm text-muted-foreground`}>
            {record.path}
          </p>
          <p className="text-base text-foreground">{record.summary}</p>
          {record.memories.length === 0 ? null : (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-muted-foreground">
                {t("memories")}
              </p>
              <ul className="flex flex-col gap-2">
                {record.memories.map((memory) => (
                  <Memory key={memory.id} at={at} memory={memory} />
                ))}
              </ul>
            </div>
          )}
          {record.action === "propose" ? (
            <DropMemoryRecord
              org={at.org}
              ws={at.ws}
              number={number}
              path={record.path}
              title={record.title}
              dropped={record.dropped}
            />
          ) : null}
        </article>
      ))}
    </div>
  );
}
