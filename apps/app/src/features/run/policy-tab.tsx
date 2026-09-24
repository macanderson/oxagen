// The Policy tab (mockup `pRun`, the `policy` branch; pages/run.md, Policy):
// "Policy decisions", one row per decision the run's record carries, from the
// whole-run transcript the page read to its end.
//
// Frame and Call and Outcome are recorded on every decision frame. The rules
// that fired, the taint on the call's inputs and the decision's own latency
// are not on the transcript today, so each of those cells says so rather than
// guessing. A list read from a transcript that stopped short says it is a
// prefix, and a failed read says it failed.
import { useTranslations } from "next-intl";
import type { RunTranscript, TranscriptEntry } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { type ListRow, ListTable } from "@/ui/list-table";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Note, NoValue, Panel, PanelBody } from "./parts";
import { entriesOf } from "./recorded-entries";
import type { Place, RunTabProps } from "./tab-props";
import { decisionSubject, entryKey } from "./transcript-model";
import { isWhole } from "./whole-transcript";

/** A frame's seq, linked to the frame player when it is on the run's own chain. */
export function FrameLink({
  seq,
  chainRef,
  place,
}: {
  seq: string;
  /** Set for a subagent's frame, which the player cannot open by seq. */
  chainRef: string | undefined;
  place: Place;
}) {
  // The player reads the run's own chain. A subagent's frame shares its seq
  // with a different frame there, so it is named and not linked.
  if (chainRef !== undefined)
    return <span className={`${mono} text-muted-foreground`}>{seq}</span>;
  return (
    <SafeLink
      to={routes.run(place.org, place.ws, place.runId, {
        tab: "actions",
        body: seq,
      })}
      className={`${mono} text-muted-foreground hover:text-foreground`}
    >
      {seq}
    </SafeLink>
  );
}

/** The outcome's pill: `.b-allowed` for an allow, `.b-approval` for a call routed to a person. */
function outcomeTone(decision: string): BadgeTone {
  if (decision === "allow") return "allowed";
  if (decision === "deny") return "denied";
  if (decision === "ask" || decision === "approval" || decision === "approve")
    return "approval";
  return "quiet";
}

/** A cell the transcript does not carry yet, with the reason on hover. */
function Unrecorded() {
  const t = useTranslations("run.policy");
  return (
    <span
      title={t("unrecorded")}
      className="whitespace-nowrap font-sans text-[12px]"
    >
      <NoValue />
    </span>
  );
}

function row(entry: TranscriptEntry, place: Place): ListRow {
  const decision = entry.decision;
  return {
    key: entryKey(entry),
    data: { "data-testid": "run-policy-decision" },
    cells: [
      <FrameLink
        key="frame"
        seq={decision?.seq ?? entry.seq}
        chainRef={
          decision === null ? entry.subagent?.chainRef : decision.chainRef
        }
        place={place}
      />,
      <span key="call" className="flex min-w-0 flex-col">
        <span className={`${mono} text-foreground`}>
          {decisionSubject(entry) ?? entry.label}
        </span>
        <span className={`${mono} text-[11px] text-dim`}>
          {decision?.type ?? entry.type}
        </span>
      </span>,
      decision === null ? (
        <NoValue key="outcome" />
      ) : (
        <Badge key="outcome" tone={outcomeTone(decision.decision)}>
          {decision.decision}
        </Badge>
      ),
      <Unrecorded key="rules" />,
      <Unrecorded key="taint" />,
      <Unrecorded key="latency" />,
    ],
  };
}

/**
 * The "Policy decisions" panel over a whole-run read.
 *
 * @internal Exported for its unit test; the page renders it through PolicyTab.
 */
export function PolicyDecisions({
  read,
  place,
}: {
  read: Read<RunTranscript>;
  place: Place;
}) {
  const t = useTranslations("run.policy");
  const entries = entriesOf(read, "policy");
  if (entries === null || !read.ok)
    return (
      <Panel title={t("title")} testId="run-policy">
        {read.ok ? null : <ReadFailure read={read} section={t("title")} />}
      </Panel>
    );
  return (
    <Panel title={t("title")} flush testId="run-policy">
      {entries.length === 0 ? (
        <PanelBody>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </PanelBody>
      ) : (
        <ListTable
          label={t("title")}
          columns={[
            { label: t("frame") },
            { label: t("call") },
            { label: t("outcome") },
            { label: t("rules") },
            { label: t("taint") },
            { label: t("latency"), numeric: true },
          ]}
          rows={entries.map((entry) => row(entry, place))}
        />
      )}
      <PanelBody rule={entries.length > 0}>
        <div className="flex flex-col gap-2">
          <Note>{t("note")}</Note>
          {isWhole(read.value) ? null : (
            <p className="text-xs text-muted-foreground">{t("cut")}</p>
          )}
        </div>
      </PanelBody>
    </Panel>
  );
}

/** The Policy tab: the whole-run transcript narrowed to its decisions. It makes no read of its own. */
export function PolicyTab({ everything, place }: RunTabProps) {
  return <PolicyDecisions read={everything} place={place} />;
}
