// Imported only into the client graph (via benchmark-dashboard), so no own
// "use client" directive is needed.
import { Card, SectionTitle } from "@/components/atoms";
import { cn } from "@/lib/format";
import { SOURCES } from "@/lib/sources";

const KIND_LABELS: Readonly<Record<(typeof SOURCES)[number]["kind"], string>> = {
  paper: "Paper",
  leaderboard: "Leaderboard",
  tool: "Tool",
};

/** The full bibliography backing every claim on this page. */
export function SourcesList(): React.ReactElement {
  return (
    <Card>
      <SectionTitle title="Sources" hint={`${SOURCES.length} cited`} />
      <ol className="flex flex-col gap-3">
        {SOURCES.map((source) => (
          <li key={source.url} className="flex flex-wrap items-baseline gap-2 text-sm">
            <span
              className={cn(
                "rounded bg-graphite-850 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-graphite-400",
              )}
            >
              {KIND_LABELS[source.kind]}
            </span>
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-ember underline underline-offset-2"
            >
              {source.title}
            </a>
            {source.published ? <span className="text-graphite-500">({source.published})</span> : null}
            <span className="text-graphite-400">— {source.description}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
