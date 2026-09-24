// Three of the Run page's tabs (spec pages/run.md): Issues, Policy and
// Context. Policy and Context each read the run's transcript narrowed to their
// own chip, page by page to the end (`readWholeTranscript`), and list the
// entries that carry a policy decision or a recall. A list that stops short of
// the end (`isWhole`) says it is a prefix; a failed read says it failed.
//
// Policy lists what Oxagen policy and operators decided, operator commands
// included, and folds the agent harness's own permission checks below them.
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

/**
 * The `policy_source` words that name the agent's own harness checking itself
 * rather than Oxagen policy or an operator deciding. The Policy tab folds
 * these away by default (#4023): a Claude Code permission prompt is the
 * harness's decision, and listing hundreds of them buried the few Oxagen made.
 */
const HARNESS_SOURCES: ReadonlySet<string> = new Set([
  "harness",
  "managed_settings",
]);

/** The key under `run.policy.by` each recorded source reads as. */
const SOURCE_COPY = {
  bundle: "oxagen",
  kernel: "oxagen",
  human: "operator",
  harness: "harness",
  managed_settings: "managedSettings",
} as const;

/** The copy key for a recorded source; undefined for a word this list lacks. */
function sourceCopy(
  source: string,
): (typeof SOURCE_COPY)[keyof typeof SOURCE_COPY] | undefined {
  return Object.hasOwn(SOURCE_COPY, source)
    ? SOURCE_COPY[source as keyof typeof SOURCE_COPY]
    : undefined;
}

function isHarnessCheck(entry: TranscriptEntry): boolean {
  const source = entry.decision?.source ?? null;
  return source !== null && HARNESS_SOURCES.has(source);
}

function DecisionTable({
  entries,
  label,
  place,
}: {
  entries: TranscriptEntry[];
  label: string;
  place: Place;
}) {
  const t = useTranslations("run.policy");
  const locale = useLocale();
  return (
    <Table
      label={label}
      columns={[
        { label: t("frame") },
        { label: t("call") },
        { label: t("outcome") },
        { label: t("decidedBy") },
        { label: t("type") },
        { label: t("at"), numeric: true },
      ]}
    >
      {entries.map((entry) => {
        const source = entry.decision?.source ?? null;
        const copy = source === null ? undefined : sourceCopy(source);
        return (
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
            <td className={cell}>
              {source === null ? (
                <span className="text-muted-foreground">
                  {t("by.unrecorded")}
                </span>
              ) : copy === undefined ? (
                <span className={mono}>{source}</span>
              ) : (
                t(`by.${copy}`)
              )}
            </td>
            <td className={`${cell} ${mono}`}>
              {entry.decision?.type ?? entry.type}
            </td>
            <td className={`${cell} text-right tabular-nums`}>
              {formatDuration(entry.elapsedMs, locale)}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

export function PolicySection({
  read,
  place,
}: {
  read: Read<RunTranscript>;
  place: Place;
}) {
  const t = useTranslations("run.policy");
  const entries = entriesOf(read, "policy");
  if (entries === null || !read.ok) {
    return (
      <Panel title={t("title")}>
        {read.ok ? null : <ReadFailure read={read} section={t("title")} />}
      </Panel>
    );
  }
  // Oxagen policy and operator decisions lead; the harness's own checks sit
  // folded below them, one click away (#4023).
  const decided = entries.filter((entry) => !isHarnessCheck(entry));
  const checks = entries.filter(isHarnessCheck);
  return (
    <Panel title={t("title")}>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : decided.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("onlyChecks")}</p>
      ) : (
        <DecisionTable entries={decided} label={t("title")} place={place} />
      )}
      {checks.length === 0 ? null : (
        <details data-testid="harness-checks" className="pt-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t("checks", { count: checks.length })}
          </summary>
          <div className="pt-2">
            <DecisionTable
              entries={checks}
              label={t("checksTitle")}
              place={place}
            />
          </div>
        </details>
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
