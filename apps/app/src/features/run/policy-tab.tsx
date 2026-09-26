// The Policy tab (mockup `pRun`, the `policy` branch; pages/run.md, Policy):
// "Policy decisions", one row per decision the run's record carries, from the
// whole-run transcript the page read to its end.
//
// Frame and Call and Outcome are recorded on every decision frame, and the
// Outcome cell names who decided from the frame's `policy_source`. The table
// lists what Oxagen policy and operators decided, operator commands included
// (#4034). The agent harness's own permission checks sit folded below it, so
// hundreds of permission prompts do not bury the few Oxagen made.
//
// Rules that fired are the decision's own `rules`, in the order they were
// evaluated (#3971, ADR-201): a bundle's permission patterns, or the kernel's
// decision rule ids. Each prints in mono. A rule that names a mandate gate
// links to the mandate's page. A permission pattern and a workspace decision
// rule, which lives in the workspace's settings, have no page, so they print
// without a link.
//
// No producer assesses taint yet, so a decision's taint is null and its cell
// says it is not recorded; an empty list would mean none. The decision's own
// latency is not on the transcript either. A list read from a transcript that
// stopped short says it is a prefix, and a failed read says it failed.
import { useTranslations } from "next-intl";
import type { RunTranscript, TranscriptEntry } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import { linkText, mono } from "@/ui/control-styles";
import { type ListRow, ListTable } from "@/ui/list-table";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Note, NoValue, Panel, PanelBody } from "./parts";
import { entriesOf } from "./recorded-entries";
import type { FrameTabProps, Place } from "./tab-props";
import { entryKey } from "./transcript-rows";
import { isWhole } from "./whole-transcript";

/** A frame's seq, linked to the frame player when it is on the run's own chain. */
export function FrameLink({
  seq,
  chainRef,
  place,
  label = seq,
}: {
  seq: string;
  /** Set for a subagent's frame, which the player cannot open by seq. */
  chainRef: string | undefined;
  place: Place;
  /** The link's words where a bare seq would not say it is a frame. */
  label?: string;
}) {
  // The player reads the run's own chain. A subagent's frame shares its seq
  // with a different frame there, so it is named and not linked.
  if (chainRef !== undefined)
    return <span className={`${mono} text-muted-foreground`}>{label}</span>;
  return (
    <SafeLink
      to={routes.run(place.org, place.ws, place.runId, {
        tab: "actions",
        body: seq,
      })}
      className={`${mono} text-muted-foreground hover:text-foreground`}
    >
      {label}
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

/** The key under `run.policy.by` each recorded source reads as. */
const SOURCE_COPY = {
  bundle: "oxagen",
  kernel: "oxagen",
  human: "operator",
  harness: "harness",
  managed_settings: "managedSettings",
} as const;

function sourceCopy(
  source: string,
): (typeof SOURCE_COPY)[keyof typeof SOURCE_COPY] | undefined {
  return Object.entries(SOURCE_COPY).find(([key]) => key === source)?.[1];
}

/**
 * Whether a decision is the harness checking itself, which the table folds
 * away (#4023, #4034). The server decides which sources those are and says so
 * on the decision (ADR-182).
 *
 * @internal Exported for its unit test.
 */
export function isHarnessCheck(entry: TranscriptEntry): boolean {
  return entry.decision?.harness === true;
}

/** Who decided, under the outcome: a recorded source by name, else that it is not recorded. */
function DecidedBy({ source }: { source: string | null }) {
  const t = useTranslations("run.policy");
  const copy = source === null ? undefined : sourceCopy(source);
  return (
    <span data-testid="policy-decided-by" className="text-[11px] text-dim">
      {source === null
        ? t("decidedByUnrecorded")
        : t("decidedBy", {
            who: copy === undefined ? source : t(`by.${copy}`),
          })}
    </span>
  );
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

/**
 * A mandate gate cites itself as `mandate:<publicId>:<gate>`
 * (`packages/rules/src/mandates.ts`). A mandate is a record with a page, so a
 * rule of that shape links to it.
 */
const MANDATE_RULE = /^mandate:(mnd_[0-9A-Za-z]+):/;

/**
 * The mandate a rule names, or null for every other rule: a bundle's
 * permission pattern and a workspace decision rule have no page of their own.
 */
function ruleMandate(rule: string): string | null {
  return MANDATE_RULE.exec(rule)?.[1] ?? null;
}

const listedLine = `${mono} text-foreground [overflow-wrap:anywhere]`;

/**
 * Words the record holds for a decision, one per line in mono: the rules that
 * fired, or the taint labels. An empty list prints "none", which the record
 * says in so many words. With `place`, a rule that names a mandate links to
 * the mandate's page.
 */
function Listed({
  items,
  testId,
  place,
}: {
  items: readonly string[];
  testId: string;
  place?: Place;
}) {
  const t = useTranslations("run.policy");
  if (items.length === 0)
    return (
      <span data-testid={testId} className="text-[12px] text-muted-foreground">
        {t("none")}
      </span>
    );
  return (
    <span data-testid={testId} className="flex min-w-0 flex-col gap-0.5">
      {items.map((item, i) => {
        // A list can name one rule twice across chains; the position keeps
        // each line its own key.
        const key = `${String(i)}:${item}`;
        const mandate = place === undefined ? null : ruleMandate(item);
        return mandate === null || place === undefined ? (
          <span key={key} className={listedLine}>
            {item}
          </span>
        ) : (
          <SafeLink
            key={key}
            to={routes.mandate(place.org, place.ws, mandate)}
            className={`${mono} ${linkText} [overflow-wrap:anywhere]`}
          >
            {item}
          </SafeLink>
        );
      })}
    </span>
  );
}

function row(entry: TranscriptEntry, place: Place): ListRow {
  const decision = entry.decision;
  // The call the decision was made on, as the server states it. A gate frame
  // that names no call (`policy deny`) says what was decided and not about
  // what, so the cell says the call is not recorded rather than printing the
  // frame's label as if it were one.
  const call = entry.subject;
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
        {call === null ? (
          <NoValue />
        ) : (
          <span className={`${mono} text-foreground`}>{call}</span>
        )}
        <span className={`${mono} text-[11px] text-dim`}>
          {decision?.type ?? entry.type}
        </span>
      </span>,
      decision === null ? (
        <NoValue key="outcome" />
      ) : (
        <span key="outcome" className="flex flex-col items-start gap-1">
          <Badge tone={outcomeTone(decision.decision)}>
            {decision.decision}
          </Badge>
          <DecidedBy source={decision.source ?? null} />
        </span>
      ),
      decision === null ? (
        <NoValue key="rules" />
      ) : (
        <Listed
          key="rules"
          items={decision.rules}
          testId="policy-rules"
          place={place}
        />
      ),
      decision === null || decision.taint === null ? (
        <Unrecorded key="taint" />
      ) : (
        <Listed key="taint" items={decision.taint} testId="policy-taint" />
      ),
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
  // Oxagen policy and operator decisions lead; the harness's own checks sit
  // folded below them, one click away (#4034).
  const decided = entries.filter((entry) => !isHarnessCheck(entry));
  const checks = entries.filter(isHarnessCheck);
  return (
    <Panel title={t("title")} flush testId="run-policy">
      {entries.length === 0 ? (
        <PanelBody>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </PanelBody>
      ) : decided.length === 0 ? (
        <PanelBody>
          <p className="text-sm text-muted-foreground">{t("onlyChecks")}</p>
        </PanelBody>
      ) : (
        <DecisionTable entries={decided} label={t("title")} place={place} />
      )}
      {checks.length === 0 ? null : (
        <PanelBody rule>
          <details data-testid="harness-checks">
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
        </PanelBody>
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

/** The mockup's six columns over a set of decisions. */
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
  return (
    <ListTable
      label={label}
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
  );
}

/** The Policy tab: the whole-run transcript narrowed to its decisions. It makes no read of its own. */
export function PolicyTab({ everything, place }: FrameTabProps) {
  return <PolicyDecisions read={everything} place={place} />;
}
