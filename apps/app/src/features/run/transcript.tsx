// The Transcript tab (mockup `pRun`'s transcript; spec §14): every run drawn
// the same way, from the run's start through each turn and its steps to each
// frame's body, with a transport that replays it.
//
// One read serves every zoom level: the transcript at `everything`, one entry
// per frame with the turn it falls in, so the view groups turns and steps
// itself and a change of level opens and closes disclosures rather than
// fetching again. Nothing here is stored, and nothing is inferred: a frame
// whose body was not retained says `digest_only` rather than showing an empty
// bubble, a body cut at the contract's ceiling links to the whole of it on
// the Frames tab, and a transcript that could not carry the whole run says how
// far it reached.
import { useTranslations } from "next-intl";
import type { RunTranscript } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { ReadFailure } from "@/ui/read-failure";
import { Panel } from "./parts";
import { TranscriptView } from "./transcript-view";

type Place = { org: string; ws: string; runId: string };

export function TranscriptSection({
  read,
  zoom,
  run,
  org,
  ws,
  runId,
}: {
  /** The transcript at `everything`: one entry per frame. */
  read: Read<RunTranscript>;
  /** The level the URL asked for: which disclosures start open. */
  zoom: RunTranscript["zoom"];
  run: Pick<RunRow, "status" | "replayGrade">;
} & Place) {
  const t = useTranslations("run.transcript");
  if (!read.ok || read.value.entries.length === 0) {
    return (
      <Panel title={t("title")}>
        {!read.ok ? (
          <ReadFailure read={read} section={t("title")} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        )}
      </Panel>
    );
  }
  return (
    <TranscriptView
      transcript={read.value}
      zoom={zoom}
      status={run.status}
      replayGrade={run.replayGrade}
      org={org}
      ws={ws}
      runId={runId}
    />
  );
}
