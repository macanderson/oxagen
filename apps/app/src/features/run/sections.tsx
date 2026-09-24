// Three of the Run page's tabs (spec pages/run.md): Issues, Policy and
// Context. Policy and Context each read the run's transcript narrowed to their
// own chip, page by page to the end (`readWholeTranscript`), and list the
// entries that carry a policy decision or a recall. A list that stops short of
// the end (`isWhole`) says it is a prefix; a failed read says it failed.
import { useLocale, useTranslations } from "next-intl";
import type { RunTranscript, TranscriptEntry } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { formatDuration } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, Table } from "@/ui/table";
import { Panel } from "./parts";
import { entryKey } from "./transcript-model";
import { isWhole } from "./whole-transcript";
import type { RunTabProps } from "./tab-props";

type Place = { org: string; ws: string; runId: string };

/** The entries of a whole-run transcript that answer to one chip. */
export function entriesOf(
  read: Read<RunTranscript>,
  kind: "policy" | "recall",
): TranscriptEntry[] | null {
  return read.ok
    ? read.value.entries.filter((entry) => entry.kinds.includes(kind))
    : null;
}

export function IssuesSection({ run }: { run: RunRow }) {
  const t = useTranslations("run.issues");
  return (
    <Panel title={t("title")}>
      {run.taskRef === null ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[{ label: t("reference") }, { label: t("relation") }]}
        >
          <tr>
            <td className={`${cell} ${mono}`}>{run.taskRef}</td>
            <td className={cell}>{t("task")}</td>
          </tr>
        </Table>
      )}
      <p className="pt-3 text-xs text-muted-foreground">{t("note")}</p>
    </Panel>
  );
}

function FrameLink({
  seq,
  chainRef,
  place,
}: {
  seq: string;
  /** Set for a subagent's frame, which the Frames tab cannot open by seq. */
  chainRef: string | undefined;
  place: Place;
}) {
  // The Frames tab reads the run's own chain. A subagent's frame shares its
  // seq with a different frame there, so it is named and not linked.
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

function outcomeTone(decision: string) {
  if (decision === "allow") return "allowed" as const;
  if (decision === "deny") return "denied" as const;
  if (decision === "ask" || decision === "approval") return "approval" as const;
  return "quiet" as const;
}

export function PolicySection({
  read,
  place,
}: {
  read: Read<RunTranscript>;
  place: Place;
}) {
  const t = useTranslations("run.policy");
  const locale = useLocale();
  const entries = entriesOf(read, "policy");
  if (entries === null || !read.ok) {
    return (
      <Panel title={t("title")}>
        {read.ok ? null : <ReadFailure read={read} section={t("title")} />}
      </Panel>
    );
  }
  return (
    <Panel title={t("title")}>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("frame") },
            { label: t("call") },
            { label: t("outcome") },
            { label: t("type") },
            { label: t("at"), numeric: true },
          ]}
        >
          {entries.map((entry) => (
            <tr key={entryKey(entry)}>
              <td className={cell}>
                <FrameLink
                  seq={entry.decision?.seq ?? entry.seq}
                  chainRef={
                    entry.decision === null
                      ? entry.subagent?.chainRef
                      : entry.decision.chainRef
                  }
                  place={place}
                />
              </td>
              <td className={`${cell} ${mono}`}>{entry.label}</td>
              <td className={cell}>
                {entry.decision === null ? null : (
                  <Badge tone={outcomeTone(entry.decision.decision)}>
                    {entry.decision.decision}
                  </Badge>
                )}
              </td>
              <td className={`${cell} ${mono}`}>
                {entry.decision?.type ?? entry.type}
              </td>
              <td className={`${cell} text-right tabular-nums`}>
                {formatDuration(entry.elapsedMs, locale)}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {isWhole(read.value) ? null : (
        <p className="pt-3 text-xs text-muted-foreground">{t("cut")}</p>
      )}
    </Panel>
  );
}

export function ContextSection({
  read,
  place,
}: {
  read: Read<RunTranscript>;
  place: Place;
}) {
  const t = useTranslations("run.context");
  const locale = useLocale();
  const entries = entriesOf(read, "recall");
  if (entries === null || !read.ok) {
    return (
      <Panel title={t("title")}>
        {read.ok ? null : <ReadFailure read={read} section={t("title")} />}
      </Panel>
    );
  }
  return (
    <Panel title={t("title")}>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("frame") },
            { label: t("what") },
            { label: t("at"), numeric: true },
          ]}
        >
          {entries.map((entry) => (
            <tr key={entryKey(entry)}>
              <td className={cell}>
                <FrameLink
                  seq={entry.seq}
                  chainRef={entry.subagent?.chainRef}
                  place={place}
                />
              </td>
              <td className={`${cell} ${mono}`}>{entry.label}</td>
              <td className={`${cell} text-right tabular-nums`}>
                {formatDuration(entry.elapsedMs, locale)}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {isWhole(read.value) ? null : (
        <p className="pt-3 text-xs text-muted-foreground">{t("cut")}</p>
      )}
    </Panel>
  );
}

/** The Issues tab over the page's bundle. */
export function IssuesTab({ run }: RunTabProps) {
  return <IssuesSection run={run} />;
}

/** The Policy tab: the whole-run transcript narrowed to its decisions. */
export function PolicyTab({ everything, place }: RunTabProps) {
  return <PolicySection read={everything} place={place} />;
}

/** The Context tab: the whole-run transcript narrowed to its recalls. */
export function ContextTab({ everything, place }: RunTabProps) {
  return <ContextSection read={everything} place={place} />;
}
