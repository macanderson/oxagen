// The Transcript tab (mockup `transcriptTab`; pages/run.md, Transcript), the
// Run page's default: the run as its operator saw it, with the kind chips,
// the search, the transport, the header line and the burn meter over it.
//
// It reads nothing of its own. The page already read the whole-run
// transcript at `everything` to its end, and the tab filters and plays that
// in the browser, so a chip's count is the count of the rows it shows. A
// frame whose body was not retained draws no row rather than an empty one,
// a body cut at the contract's ceiling says so and links to the whole of it,
// and a transcript that could not carry the whole run pages the rest in.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RunTranscript } from "@/data/contracts/run";
import { TRANSCRIPT_KINDS } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { ReadFailure } from "@/ui/read-failure";
import { LiveEmptyFollow } from "./live-empty-follow";
import { Panel } from "./parts";
import type { KindFilter, RunTabProps } from "./tab-props";
import { isNonEmpty } from "./transcript-model";
import { type TranscriptRun, TranscriptView } from "./transcript-view";

type Place = { org: string; ws: string; runId: string };

/**
 * The filter as a URL value: `tools,errors`, or `none`. The order follows the
 * contract's own list rather than the order they were pressed, so one filter
 * has one URL. The tab strip carries it on the Transcript tab's link, and the
 * tab opens its chips from it.
 */
export function kindsParam(kinds: KindFilter): string | undefined {
  if (kinds === "none") return "none";
  const picked = TRANSCRIPT_KINDS.filter((kind) => kinds.includes(kind));
  return picked.length === 0 ? undefined : picked.join(",");
}

/**
 * `?kinds=` as a filter. `none` is every chip off, as the all and none toggle
 * leaves them; an unknown word is dropped, not refused.
 */
export function parseKinds(raw: string | null): KindFilter {
  if (raw === null) return [];
  if (raw === "none") return "none";
  const asked = new Set(raw.split(","));
  return TRANSCRIPT_KINDS.filter((kind) => asked.has(kind));
}

/** @internal The tab's body over one read; the page renders it through `TranscriptTab`. */
export function TranscriptSection({
  read,
  run,
  kinds,
  org,
  ws,
  runId,
}: {
  /** The whole-run transcript at `everything`: one entry per frame. */
  read: Read<RunTranscript>;
  run: TranscriptRun;
  /** The URL's `?kinds=`, which sets the chips the tab opens with. */
  kinds: KindFilter;
} & Place) {
  const t = useTranslations("run.transcript");
  if (!read.ok) {
    return (
      <Panel title={t("title")}>
        <ReadFailure read={read} section={t("title")} />
      </Panel>
    );
  }
  const { entries } = read.value;
  if (!isNonEmpty(entries)) {
    return (
      <Panel title={t("title")}>
        <p
          data-testid="transcript-empty"
          className="max-w-prose text-sm text-muted-foreground"
        >
          {t("empty")}
        </p>
        {run.status === "live" ? (
          <LiveEmptyFollow org={org} ws={ws} runId={runId} />
        ) : null}
      </Panel>
    );
  }
  return (
    <TranscriptView
      transcript={read.value}
      entries={entries}
      run={run}
      kinds={kinds}
      org={org}
      ws={ws}
      runId={runId}
    />
  );
}

/**
 * The Transcript tab over the page's bundle. The page awaits every tab the
 * same way, so this answers a promise although it makes no read of its own.
 */
export function TranscriptTab(props: RunTabProps): Promise<ReactNode> {
  const { run, view, place, everything } = props;
  return Promise.resolve(
    <TranscriptSection
      read={everything}
      run={run}
      kinds={view.kinds}
      {...place}
    />,
  );
}
