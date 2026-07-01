// Imported only into the client graph (via benchmark-dashboard), so no own
// "use client" directive is needed.
import { Card } from "@/components/atoms";
import { cn } from "@/lib/format";

/**
 * The dashboard's honesty policy, stated up front and unmissable. When every
 * row on screen is SAMPLE data, this escalates to a loud warning instead of
 * the quiet policy statement — there is nothing measured to show yet.
 */
export function TrustBanner({ allSample }: { readonly allSample: boolean }): React.ReactElement {
  if (allSample) {
    return (
      <Card className="border-amber-500/50 bg-amber-500/10">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-lg">⚠️</span>
          <div>
            <p className="text-sm font-semibold text-amber-300">
              Showing SAMPLE data — no verified runs recorded yet.
            </p>
            <p className="mt-1 text-sm text-amber-100/80">
              Every row below is illustrative only, not a real benchmark run. Run{" "}
              <code className="rounded bg-graphite-950/60 px-1.5 py-0.5 text-amber-200">
                pnpm bench:swe:compare
              </code>{" "}
              to populate real results.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className={cn("border-graphite-700")}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-lg">🔍</span>
        <div className="text-sm text-graphite-300">
          <p className="font-semibold text-graphite-100">No simulated scores. Ever.</p>
          <p className="mt-1">
            Every number below is either <strong className="text-graphite-100">measured</strong> by our
            own harness run — tagged with model, dataset, date, git SHA, and a reproduce command — or{" "}
            <strong className="text-graphite-100">cited</strong> from a dated primary source. Sample rows
            are visually flagged and never used in a headline claim. Competitor rankings are never
            hardcoded here — we link out to the live, third-party-verified leaderboard instead.
          </p>
        </div>
      </div>
    </Card>
  );
}
