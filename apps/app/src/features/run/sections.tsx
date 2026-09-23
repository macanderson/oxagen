// Three of the Run page's tabs (spec pages/run.md): Issues, Policy and
// Context. Policy and Context read the whole-run transcript the page already
// holds, filtered to the entries that carry a policy decision or a recall, so
// they add no read of their own. A transcript that stopped short says the
// list is a prefix; a failed read says it failed.
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

function FrameLink({ seq, place }: { seq: string; place: Place }) {
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
            <tr key={entry.seq}>
              <td className={cell}>
                <FrameLink
                  seq={entry.decision?.seq ?? entry.seq}
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
      {read.value.complete ? null : (
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
            <tr key={entry.seq}>
              <td className={cell}>
                <FrameLink seq={entry.seq} place={place} />
              </td>
              <td className={`${cell} ${mono}`}>{entry.label}</td>
              <td className={`${cell} text-right tabular-nums`}>
                {formatDuration(entry.elapsedMs, locale)}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {read.value.complete ? null : (
        <p className="pt-3 text-xs text-muted-foreground">{t("cut")}</p>
      )}
    </Panel>
  );
}
